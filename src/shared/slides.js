// Detects "the slide changed" locally, with no model and no network.
//
// The naive approach — diffing raw pixels — fails immediately in a meeting,
// because a webcam tile of a talking presenter changes every single frame.
// So instead of asking "how much did the picture change", this asks
// "what FRACTION OF THE SCREEN changed":
//
//   • a speaker's face occupies 1-2 blocks out of 144  → ~1%, ignored
//   • a new slide repaints nearly everything           → 60-100%, caught
//
// A change also has to hold still before it is saved, otherwise a fade or a
// build animation gets captured half-finished.

const SIG_W = 320;   // signature resolution — small on purpose, this must be cheap
const SIG_H = 180;
const COLS = 16;
const ROWS = 9;
const BLOCKS = COLS * ROWS;

export const SLIDE_DEFAULTS = {
  slideIntervalSec: 3,      // how often to look
  blockDelta: 10,           // 0-255: how different one block must be to count as changed
  changeThreshold: 0.20,    // fraction of blocks that must change to call it a new slide
  stableThreshold: 0.03,    // "the picture has settled" tolerance
  stabilityChecks: 1,       // confirming samples required before saving
  slideQuality: 0.8,
  maxSlides: 300,
};

export function createSlideDetector(options = {}) {
  const cfg = { ...SLIDE_DEFAULTS, ...options };

  const canvas = new OffscreenCanvas(SIG_W, SIG_H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let reference = null;   // signature of the last SAVED slide
  let candidate = null;   // a frame that differs from reference, waiting to settle
  let stable = 0;
  let lastRatio = 0;

  function configure(next) {
    Object.assign(cfg, next);
  }

  function signature(source, roi) {
    ctx.clearRect(0, 0, SIG_W, SIG_H);
    if (roi) {
      ctx.drawImage(source, roi.x, roi.y, roi.w, roi.h, 0, 0, SIG_W, SIG_H);
    } else {
      ctx.drawImage(source, 0, 0, SIG_W, SIG_H);
    }
    const { data } = ctx.getImageData(0, 0, SIG_W, SIG_H);

    const sums = new Float32Array(BLOCKS);
    const counts = new Uint32Array(BLOCKS);
    const blockW = SIG_W / COLS;
    const blockH = SIG_H / ROWS;

    for (let y = 0; y < SIG_H; y++) {
      const row = Math.min(ROWS - 1, (y / blockH) | 0);
      for (let x = 0; x < SIG_W; x++) {
        const col = Math.min(COLS - 1, (x / blockW) | 0);
        const i = (y * SIG_W + x) * 4;
        // Rec. 601 luma — cheaper than a real colour-space conversion and plenty
        // for telling one slide from another.
        const luma = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        const b = row * COLS + col;
        sums[b] += luma;
        counts[b] += 1;
      }
    }
    for (let b = 0; b < BLOCKS; b++) sums[b] /= counts[b] || 1;
    return sums;
  }

  function ratio(a, b) {
    if (!a || !b) return 1;
    let changed = 0;
    for (let i = 0; i < BLOCKS; i++) {
      if (Math.abs(a[i] - b[i]) > cfg.blockDelta) changed += 1;
    }
    return changed / BLOCKS;
  }

  /**
   * @returns {{save: boolean, ratio: number, phase: string}}
   *   phase: 'idle' | 'candidate' | 'settling' | 'save'
   */
  function check(source, roi = null) {
    const sig = signature(source, roi);

    // Nothing saved yet: capture whatever is on screen once it holds still.
    if (!reference) {
      if (!candidate) {
        candidate = sig;
        stable = 0;
        return { save: false, ratio: 0, phase: 'candidate' };
      }
      const settle = ratio(sig, candidate);
      lastRatio = settle;
      if (settle <= cfg.stableThreshold) {
        stable += 1;
        if (stable >= cfg.stabilityChecks) {
          reference = sig;
          candidate = null;
          stable = 0;
          return { save: true, ratio: settle, phase: 'save' };
        }
        return { save: false, ratio: settle, phase: 'settling' };
      }
      candidate = sig;
      stable = 0;
      return { save: false, ratio: settle, phase: 'candidate' };
    }

    const changed = ratio(sig, reference);
    lastRatio = changed;

    if (changed < cfg.changeThreshold) {
      // Still the same slide. Drop any half-formed candidate — this is what
      // stops a transient (someone dragging a window) from ever being saved.
      candidate = null;
      stable = 0;
      return { save: false, ratio: changed, phase: 'idle' };
    }

    if (!candidate) {
      candidate = sig;
      stable = 0;
      return { save: false, ratio: changed, phase: 'candidate' };
    }

    const settle = ratio(sig, candidate);
    if (settle <= cfg.stableThreshold) {
      stable += 1;
      if (stable >= cfg.stabilityChecks) {
        reference = sig;
        candidate = null;
        stable = 0;
        return { save: true, ratio: changed, phase: 'save' };
      }
      return { save: false, ratio: changed, phase: 'settling' };
    }

    // Still moving (fade / animation) — wait for it to finish.
    candidate = sig;
    stable = 0;
    return { save: false, ratio: changed, phase: 'candidate' };
  }

  function reset() {
    reference = null;
    candidate = null;
    stable = 0;
    lastRatio = 0;
  }

  return {
    check,
    reset,
    configure,
    get lastRatio() { return lastRatio; },
    get config() { return { ...cfg }; },
  };
}
