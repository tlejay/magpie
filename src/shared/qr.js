// QR decoding. No AI, no network, no model — this is a plain barcode decoder.
//
// Preferred path: Chrome's built-in BarcodeDetector (on macOS it calls Apple's
// Vision framework, so it's both fast and good). Fallback: the bundled jsQR
// library, because MV3 forbids loading scripts from the network at runtime.

const GRID = 3;          // tile the frame 3x3 when the full-frame pass finds nothing
const OVERLAP = 0.15;    // tiles overlap so a QR sitting on a seam isn't cut in half
const UPSCALE = 2;       // blow tiles up before decoding — helps with small/compressed QR
const MAX_TILE_PX = 1600;

export async function createScanner() {
  let detector = null;
  try {
    if (typeof BarcodeDetector !== 'undefined') {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        detector = new BarcodeDetector({ formats: ['qr_code'] });
      }
    }
  } catch {
    detector = null;
  }

  if (!detector && typeof self.jsQR !== 'function') {
    throw new Error('No QR decoder available (BarcodeDetector missing and jsQR not loaded)');
  }

  const engine = detector ? 'native' : 'jsqr';
  let scratch = null;
  let scratchCtx = null;

  function ensureScratch(w, h) {
    if (!scratch || scratch.width !== w || scratch.height !== h) {
      scratch = new OffscreenCanvas(w, h);
      scratchCtx = scratch.getContext('2d', { willReadFrequently: true });
    }
    // Nearest-neighbour keeps the hard black/white module edges a decoder wants.
    scratchCtx.imageSmoothingEnabled = false;
    return scratchCtx;
  }

  async function decode(canvas, ctx) {
    if (detector) {
      const codes = await detector.detect(canvas);
      return codes.map((c) => c.rawValue).filter(Boolean);
    }
    const { width, height } = canvas;
    const img = ctx.getImageData(0, 0, width, height);
    const hit = self.jsQR(img.data, width, height, { inversionAttempts: 'attemptBoth' });
    return hit && hit.data ? [hit.data] : [];
  }

  async function decodeRegion(source, sx, sy, sw, sh, scale) {
    const w = Math.min(Math.round(sw * scale), MAX_TILE_PX);
    const h = Math.min(Math.round(sh * scale), MAX_TILE_PX);
    if (w < 16 || h < 16) return [];
    const c = ensureScratch(w, h);
    c.clearRect(0, 0, w, h);
    c.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);
    return decode(scratch, c);
  }

  async function decodeInverted(source, w, h) {
    const c = ensureScratch(w, h);
    c.save();
    c.filter = 'invert(1)';
    c.drawImage(source, 0, 0, w, h);
    c.restore();
    c.filter = 'none';
    return decode(scratch, c);
  }

  /**
   * @param {OffscreenCanvas} canvas  full captured frame
   * @param {CanvasRenderingContext2D} ctx  its 2d context
   * @returns {Promise<{values: string[], pass: string}>}
   */
  async function scanFrame(canvas, ctx) {
    const { width: W, height: H } = canvas;

    // Pass 1 — whole frame. Handles the common case where the QR is reasonably big.
    let values = await decode(canvas, ctx);
    if (values.length) return { values: dedupe(values), pass: 'full' };

    // Pass 2 — overlapping tiles, upscaled. This is what catches a small QR
    // tucked into the corner of a shared slide.
    const baseW = W / GRID;
    const baseH = H / GRID;
    const ovW = baseW * OVERLAP;
    const ovH = baseH * OVERLAP;
    const found = [];
    for (let row = 0; row < GRID; row++) {
      for (let col = 0; col < GRID; col++) {
        const sx = Math.max(0, col * baseW - ovW);
        const sy = Math.max(0, row * baseH - ovH);
        const sw = Math.min(W - sx, baseW + 2 * ovW);
        const sh = Math.min(H - sy, baseH + 2 * ovH);
        found.push(...(await decodeRegion(canvas, sx, sy, sw, sh, UPSCALE)));
      }
    }
    if (found.length) return { values: dedupe(found), pass: 'tiled' };

    // Pass 3 — inverted, once. Dark-mode slides put white modules on black,
    // which some decoders refuse.
    const inverted = await decodeInverted(canvas, W, H);
    if (inverted.length) return { values: dedupe(inverted), pass: 'inverted' };

    return { values: [], pass: 'none' };
  }

  return { engine, scanFrame };
}

function dedupe(list) {
  return [...new Set(list.filter(Boolean))];
}

/** Pull the first http(s) URL out of a decoded payload, if there is one. */
export function extractUrl(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed.split(/\s/)[0];
  const m = trimmed.match(/https?:\/\/[^\s"'<>]+/i);
  return m ? m[0] : null;
}

function tokenize(list) {
  return (list || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

/** Does this payload pass the user's allow-list? Empty list = allow everything. */
export function passesFilter(text, filter) {
  const tokens = tokenize(filter);
  if (!tokens.length) return true;
  const hay = (text || '').toLowerCase();
  return tokens.some((t) => hay.includes(t));
}

/**
 * Deny-list check, applied before the allow-list.
 * Exists because of a real case: speakers put a LINE add-friend QR on their
 * intro slide, which fires an alert that is never what the user is waiting for.
 */
export function isBlocked(text, blocklist) {
  const tokens = tokenize(blocklist);
  if (!tokens.length) return false;
  const hay = (text || '').toLowerCase();
  return tokens.some((t) => hay.includes(t));
}
