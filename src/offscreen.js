// The capture hub. Runs inside the hidden offscreen document because an MV3
// service worker is torn down while idle, and a torn-down worker means a dead
// monitor and a lost recording.
//
// One tab capture feeds three consumers, each on its own cadence:
//   • QR analyser      — expensive, runs about once a minute
//   • slide analyser   — cheap, runs every few seconds
//   • audio pipeline   — continuous
//
// Each analyser owns its own canvas. Sharing one would race, because QR
// decoding is async and would be reading pixels while the slide check redraws.

import { createScanner } from './shared/qr.js';
import { createSlideDetector } from './shared/slides.js';
import { createAudioPipeline } from './shared/audio.js';
import { createSession, endSession, putAudioChunk, putSlide, updateSession } from './shared/db.js';

const video = document.getElementById('feed');
const alertSound = document.getElementById('alert');

let stream = null;
let session = null;
let startedAt = 0;
let features = { qr: false, audio: false, slides: false };
let settings = {};

let scanner = null;
let qrCanvas = null;
let qrCtx = null;
let qrTimer = null;
let scanCount = 0;

let slideDetector = null;
let saveCanvas = null;
let saveCtx = null;
let slideTimer = null;
let slideSeq = 0;

let audio = null;
let audioChunks = 0;

let running = false;

// ---------------------------------------------------------------- messaging

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;

  const async_ = (fn) => {
    Promise.resolve()
      .then(fn)
      .then((res) => sendResponse({ ok: true, ...(res || {}) }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  };

  switch (msg.type) {
    case 'START_CAPTURE': return async_(() => start(msg));
    case 'STOP_CAPTURE': return async_(() => stop());

    case 'PING':
      sendResponse({
        ok: true,
        running,
        live: isLive(),
        scanCount,
        slideCount: slideSeq,
        audioChunks,
        recording: !!audio,
        frameW: video.videoWidth,
        frameH: video.videoHeight,
      });
      return false;

    case 'PLAY_SOUND':
      playAlert(msg.volume);
      sendResponse({ ok: true });
      return false;

    case 'GET_LEVELS':
      sendResponse({ ok: true, levels: audio ? audio.getLevels() : null });
      return false;

    case 'SET_PASSTHROUGH':
      audio?.setPassthrough(msg.on);
      sendResponse({ ok: true, applied: !!audio });
      return false;

    case 'SET_OUTPUT_DEVICE': return async_(async () => {
      if (!audio) return { applied: false };
      await audio.setOutputDevice(msg.deviceId);
      return { applied: true };
    });

    case 'UPDATE_CONFIG':
      applyConfig(msg.config);
      sendResponse({ ok: true });
      return false;

    default:
      return false;
  }
});

// ---------------------------------------------------------------- lifecycle

async function start(msg) {
  await stop(); // never stack two captures

  settings = msg.settings || {};
  features = {
    qr: !!msg.features?.qr,
    audio: !!msg.features?.audio,
    slides: !!msg.features?.slides,
  };

  if (!features.qr && !features.audio && !features.slides) {
    throw new Error('ยังไม่ได้เปิดเครื่องมือสักอย่าง');
  }

  const wantsVideo = features.qr || features.slides;
  const constraints = { audio: false, video: false };

  if (wantsVideo) {
    constraints.video = {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: msg.streamId,
        maxWidth: 1920,
        maxHeight: 1080,
        // Frames are sampled every few seconds at most, so a high frame rate
        // would only burn CPU for pixels nobody looks at.
        maxFrameRate: 5,
      },
    };
  }
  if (features.audio) {
    constraints.audio = {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: msg.streamId },
    };
  }

  stream = await navigator.mediaDevices.getUserMedia(constraints);
  startedAt = Date.now();

  session = await createSession({
    tabTitle: msg.tabTitle,
    tabUrl: msg.tabUrl,
    features,
  });

  if (wantsVideo) {
    video.srcObject = new MediaStream(stream.getVideoTracks());
    // A rejected autoplay promise must not abort the start — a live MediaStream
    // still paints into the element, which is all drawImage() needs.
    await video.play().catch(() => {});
    await waitForFrame();
  }

  stream.getTracks().forEach((track) => {
    track.addEventListener('ended', () => {
      report('CAPTURE_ENDED', { reason: 'แหล่งสัญญาณของแท็บถูกตัด' });
      stop();
    });
  });

  if (features.qr) {
    scanner = await createScanner();
    scheduleQr(1000); // look almost immediately, then settle into the interval
  }
  if (features.slides) {
    slideDetector = createSlideDetector(settings);
    scheduleSlide(1500);
  }
  if (features.audio) {
    audio = await createAudioPipeline({
      tabStream: stream,
      settings,
      onChunk: async (blob, seq, offsetMs, track) => {
        await putAudioChunk(session.id, seq, blob, offsetMs, track);
        audioChunks += 1;
      },
      onNotice: (code, detail) => report('AUDIO_NOTICE', { code, detail }),
    });
    await updateSession(session.id, {
      audioMimeType: audio.mimeType,
      micIncluded: audio.micIncluded,
      audioLayout: audio.layout,
      audioTracks: audio.tracks,
    });
  }

  running = true;

  return {
    sessionId: session.id,
    engine: scanner?.engine || '',
    frameW: video.videoWidth,
    frameH: video.videoHeight,
    recording: !!audio,
    micIncluded: !!audio?.micIncluded,
    mimeType: audio?.mimeType || '',
  };
}

async function stop() {
  running = false;
  clearTimeout(qrTimer);
  clearTimeout(slideTimer);
  qrTimer = slideTimer = null;

  let summary = null;
  if (audio) {
    try {
      summary = await audio.stop();
    } catch { /* tearing down must never throw */ }
    audio = null;
  }

  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  video.srcObject = null;
  scanner = null;
  slideDetector = null;

  if (session) {
    await updateSession(session.id, {
      counts: { chunks: audioChunks, slides: slideSeq, qrHits: 0 },
    }).catch(() => {});
    await endSession(session.id).catch(() => {});
  }

  const finished = { sessionId: session?.id || null, slides: slideSeq, ...(summary || {}) };
  session = null;
  scanCount = 0;
  slideSeq = 0;
  audioChunks = 0;
  return { summary: finished };
}

function applyConfig(config) {
  settings = { ...settings, ...(config || {}) };
  slideDetector?.configure(settings);
  if (typeof config?.passthrough === 'boolean') audio?.setPassthrough(config.passthrough);
}

// ---------------------------------------------------------------- QR loop

function scheduleQr(ms) {
  clearTimeout(qrTimer);
  qrTimer = setTimeout(qrTick, ms);
}

async function qrTick() {
  if (!running || !features.qr) return;
  try {
    await scanForQr();
  } catch (err) {
    report('CAPTURE_ERROR', { error: String(err?.message || err) });
  }
  if (running) scheduleQr(Math.max(5, settings.intervalSec || 60) * 1000);
}

async function scanForQr() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) {
    report('HEARTBEAT', { scanCount, frameW: 0, frameH: 0, stalled: true });
    return;
  }

  if (!qrCanvas || qrCanvas.width !== w || qrCanvas.height !== h) {
    qrCanvas = new OffscreenCanvas(w, h);
    qrCtx = qrCanvas.getContext('2d', { willReadFrequently: true });
  }
  qrCtx.drawImage(video, 0, 0, w, h);

  const { values, pass } = await scanner.scanFrame(qrCanvas, qrCtx);
  scanCount += 1;

  if (!values.length) {
    // Nothing found — the frame is dropped here and never leaves the machine.
    report('HEARTBEAT', { scanCount, slideCount: slideSeq, audioChunks, frameW: w, frameH: h, pass });
    return;
  }

  const snapshot = settings.attachSnapshot ? await toDataUrl(qrCanvas, 1280, 0.75) : null;
  const thumb = await toDataUrl(qrCanvas, 480, 0.55);

  report('QR_FOUND', {
    values, pass, scanCount, frameW: w, frameH: h, snapshot, thumb,
    offsetMs: Date.now() - startedAt,
  });
}

// ---------------------------------------------------------------- slide loop

function scheduleSlide(ms) {
  clearTimeout(slideTimer);
  slideTimer = setTimeout(slideTick, ms);
}

async function slideTick() {
  if (!running || !features.slides) return;
  try {
    await checkSlide();
  } catch (err) {
    report('CAPTURE_ERROR', { error: String(err?.message || err) });
  }
  if (running) scheduleSlide(Math.max(1, settings.slideIntervalSec || 3) * 1000);
}

async function checkSlide() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return;
  if (slideSeq >= (settings.maxSlides || 300)) return;

  const result = slideDetector.check(video);
  if (!result.save) return;

  if (!saveCanvas || saveCanvas.width !== w || saveCanvas.height !== h) {
    saveCanvas = new OffscreenCanvas(w, h);
    saveCtx = saveCanvas.getContext('2d');
  }
  saveCtx.drawImage(video, 0, 0, w, h);
  const blob = await saveCanvas.convertToBlob({
    type: 'image/jpeg',
    quality: settings.slideQuality ?? 0.8,
  });

  const offsetMs = Date.now() - startedAt;
  slideSeq += 1;
  await putSlide(session.id, slideSeq, blob, offsetMs, { ratio: result.ratio });

  const thumb = await toDataUrl(saveCanvas, 480, 0.55);
  report('SLIDE_SAVED', { seq: slideSeq, offsetMs, ratio: result.ratio, thumb });
}

// ---------------------------------------------------------------- helpers

function isLive() {
  return !!stream && stream.getTracks().some((t) => t.readyState === 'live');
}

async function toDataUrl(source, maxWidth, quality) {
  const scale = Math.min(1, maxWidth / source.width);
  const w = Math.max(1, Math.round(source.width * scale));
  const h = Math.max(1, Math.round(source.height * scale));
  const out = new OffscreenCanvas(w, h);
  out.getContext('2d').drawImage(source, 0, 0, w, h);
  const blob = await out.convertToBlob({ type: 'image/jpeg', quality });
  return blobToDataUrl(blob);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

function waitForFrame() {
  if (video.readyState >= 2 && video.videoWidth) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { video.removeEventListener('loadeddata', done); resolve(); };
    video.addEventListener('loadeddata', done);
    setTimeout(done, 5000); // don't hang forever if the tab renders nothing
  });
}

function playAlert(volume) {
  try {
    alertSound.volume = Math.max(0, Math.min(1, volume ?? settings.volume ?? 0.8));
    alertSound.currentTime = 0;
    alertSound.play().catch(() => {});
  } catch { /* a missing sound must never break monitoring */ }
}

function report(type, payload) {
  chrome.runtime.sendMessage({ target: 'sw', type, ...payload }).catch(() => {});
}
