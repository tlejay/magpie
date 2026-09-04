// Single source of truth for everything we persist.
// Used by the service worker, popup, options page and the offscreen document.

export const DEFAULT_SETTINGS = {
  // --- which tools are armed
  enableQr: true,
  enableAudio: false,     // off by default: recording is never a surprise
  enableSlides: false,

  // --- Watch (QR)
  webhookUrl: '',
  intervalSec: 60,        // how often to grab a frame and look for a QR
  cooldownMin: 30,        // don't re-alert on the same QR within this window
  urlFilter: '',          // allow-list: comma separated substrings; empty = allow everything
  urlBlocklist: 'line.naver.jp, lin.ee',  // deny-list, wins over the allow-list
  soundEnabled: true,
  volume: 0.8,
  attachSnapshot: true,   // send the captured frame along to Discord
  maxLog: 50,

  // --- Listen (audio)
  audioLayout: 'mixed',   // 'mixed' = one file · 'separate' = tab and mic apart
  recordTabAudio: true,
  recordMic: true,
  micDeviceId: '',
  passthrough: true,      // false = record silently, hear nothing
  outputDeviceId: '',     // '' = system default
  audioBitrateKbps: 64,
  chunkSeconds: 5,        // write to IndexedDB this often; never buffer a whole meeting

  // --- Collect (slides)
  slideIntervalSec: 3,
  blockDelta: 10,         // 0-255 per-block difference that counts as "changed"
  changeThreshold: 0.20,  // fraction of the screen that must change to call it a new slide
  stableThreshold: 0.03,  // "the picture has settled" tolerance
  stabilityChecks: 1,     // confirming samples before saving
  slideQuality: 0.8,
  maxSlides: 300,

  // --- shared
  keepAwake: true,        // stop the display sleeping while monitoring
};

export const DEFAULT_STATE = {
  monitoring: false,
  tabId: null,
  tabTitle: '',
  tabUrl: '',
  startedAt: null,
  lastScanAt: null,
  lastHeartbeatAt: null,
  scanCount: 0,
  filteredCount: 0,       // QRs seen but deliberately not alerted on
  frameW: 0,
  frameH: 0,
  engine: '',             // 'native' | 'jsqr'
  lastError: '',

  // --- session in progress
  sessionId: null,
  features: { qr: false, audio: false, slides: false },
  recording: false,
  micIncluded: false,
  slideCount: 0,
  audioChunks: 0,
  audioNotice: '',        // e.g. mic denied — surfaced, never swallowed
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function getState() {
  const { state } = await chrome.storage.local.get('state');
  return { ...DEFAULT_STATE, ...(state || {}) };
}

export async function setState(patch) {
  const next = { ...(await getState()), ...patch };
  await chrome.storage.local.set({ state: next });
  return next;
}

export async function resetState() {
  await chrome.storage.local.set({ state: { ...DEFAULT_STATE } });
  return { ...DEFAULT_STATE };
}

export async function getLog() {
  const { log } = await chrome.storage.local.get('log');
  return Array.isArray(log) ? log : [];
}

export async function addLogEntry(entry) {
  const { maxLog } = await getSettings();
  const log = await getLog();
  log.unshift(entry);
  await chrome.storage.local.set({ log: log.slice(0, maxLog) });
  return log;
}

export async function updateLogEntry(id, patch) {
  const log = await getLog();
  const i = log.findIndex((e) => e.id === id);
  if (i === -1) return log;
  log[i] = { ...log[i], ...patch };
  await chrome.storage.local.set({ log });
  return log;
}

export async function clearLog() {
  await chrome.storage.local.set({ log: [] });
}

// "seen" tracks the last time we alerted on each decoded payload, so a QR that
// stays on screen for ten minutes doesn't fire ten notifications.
export async function getSeen() {
  const { seen } = await chrome.storage.local.get('seen');
  return seen && typeof seen === 'object' ? seen : {};
}

export async function markSeen(payload, ts = Date.now()) {
  const seen = await getSeen();
  seen[payload] = ts;
  // keep it from growing forever
  const entries = Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, 200);
  await chrome.storage.local.set({ seen: Object.fromEntries(entries) });
}

export async function clearSeen() {
  await chrome.storage.local.set({ seen: {} });
}
