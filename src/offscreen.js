// Runs inside the hidden offscreen document. Holds the captured tab stream,
// grabs one frame per interval, and hands anything it decodes to the worker.

import { createScanner } from './shared/qr.js';

const video = document.getElementById('feed');
const alertSound = document.getElementById('alert');

let stream = null;
let scanner = null;
let timer = null;
let running = false;
let scanCount = 0;
let config = { intervalSec: 60, attachSnapshot: true, volume: 0.8 };

let frameCanvas = null;
let frameCtx = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;

  switch (msg.type) {
    case 'START_CAPTURE':
      start(msg).then(
        (info) => sendResponse({ ok: true, ...info }),
        (err) => sendResponse({ ok: false, error: String(err && err.message || err) })
      );
      return true; // async response

    case 'STOP_CAPTURE':
      stop();
      sendResponse({ ok: true });
      return false;

    case 'PING':
      sendResponse({
        ok: true,
        running,
        live: !!stream && stream.getVideoTracks().some((t) => t.readyState === 'live'),
        scanCount,
        frameW: video.videoWidth,
        frameH: video.videoHeight,
      });
      return false;

    case 'PLAY_SOUND':
      playAlert(msg.volume);
      sendResponse({ ok: true });
      return false;

    case 'UPDATE_CONFIG':
      config = { ...config, ...msg.config };
      sendResponse({ ok: true });
      return false;

    default:
      return false;
  }
});

async function start({ streamId, settings }) {
  stop(); // never stack two captures

  config = {
    intervalSec: settings?.intervalSec ?? 60,
    attachSnapshot: settings?.attachSnapshot ?? true,
    volume: settings?.volume ?? 0.8,
  };

  stream = await navigator.mediaDevices.getUserMedia({
    audio: false, // deliberately not capturing audio — that would mute the webinar
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 2, // we sample once a minute; 30fps would just burn CPU
      },
    },
  });

  video.srcObject = stream;
  // A rejected autoplay promise must not abort the start — a live MediaStream
  // still paints into the element, which is all we need for drawImage().
  await video.play().catch(() => {});
  await waitForFrame();

  stream.getVideoTracks().forEach((track) => {
    track.addEventListener('ended', () => {
      // Happens when the captured tab is closed or navigated away.
      report('CAPTURE_ENDED', { reason: 'stream track ended' });
      stop();
    });
  });

  scanner = await createScanner();
  running = true;
  scanCount = 0;

  scheduleNext(1000); // first look almost immediately, then settle into the interval

  return {
    engine: scanner.engine,
    frameW: video.videoWidth,
    frameH: video.videoHeight,
  };
}

function stop() {
  running = false;
  clearTimeout(timer);
  timer = null;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  video.srcObject = null;
  scanner = null;
}

function scheduleNext(ms) {
  clearTimeout(timer);
  timer = setTimeout(tick, ms);
}

async function tick() {
  if (!running) return;
  try {
    await scanOnce();
  } catch (err) {
    report('CAPTURE_ERROR', { error: String(err && err.message || err) });
  }
  if (running) scheduleNext(Math.max(5, config.intervalSec) * 1000);
}

async function scanOnce() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) {
    report('HEARTBEAT', { scanCount, frameW: 0, frameH: 0, stalled: true });
    return;
  }

  if (!frameCanvas || frameCanvas.width !== w || frameCanvas.height !== h) {
    frameCanvas = new OffscreenCanvas(w, h);
    frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });
  }
  frameCtx.drawImage(video, 0, 0, w, h);

  const { values, pass } = await scanner.scanFrame(frameCanvas, frameCtx);
  scanCount += 1;

  if (!values.length) {
    // Nothing found — the frame is dropped here and never leaves the machine.
    report('HEARTBEAT', { scanCount, frameW: w, frameH: h, pass });
    return;
  }

  const snapshot = config.attachSnapshot ? await toDataUrl(frameCanvas, 1280, 0.75) : null;
  const thumb = await toDataUrl(frameCanvas, 480, 0.55);

  report('QR_FOUND', { values, pass, scanCount, frameW: w, frameH: h, snapshot, thumb });
}

async function toDataUrl(source, maxWidth, quality) {
  const scale = Math.min(1, maxWidth / source.width);
  const w = Math.max(1, Math.round(source.width * scale));
  const h = Math.max(1, Math.round(source.height * scale));
  const out = new OffscreenCanvas(w, h);
  const ctx = out.getContext('2d');
  ctx.drawImage(source, 0, 0, w, h);
  const blob = await out.convertToBlob({ type: 'image/jpeg', quality });
  return await blobToDataUrl(blob);
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
    alertSound.volume = Math.max(0, Math.min(1, volume ?? config.volume));
    alertSound.currentTime = 0;
    alertSound.play().catch(() => {});
  } catch { /* a missing sound must never break monitoring */ }
}

function report(type, payload) {
  chrome.runtime.sendMessage({ target: 'sw', type, ...payload }).catch(() => {});
}
