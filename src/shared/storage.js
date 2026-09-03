// Single source of truth for everything we persist.
// Used by the service worker, popup, options page and the offscreen document.

export const DEFAULT_SETTINGS = {
  webhookUrl: '',
  intervalSec: 60,        // how often to grab a frame and look for a QR
  cooldownMin: 30,        // don't re-alert on the same QR within this window
  urlFilter: '',          // allow-list: comma separated substrings; empty = allow everything
  urlBlocklist: 'line.naver.jp, lin.ee',  // deny-list, wins over the allow-list
  soundEnabled: true,
  volume: 0.8,
  attachSnapshot: true,   // send the captured frame along to Discord
  keepAwake: true,        // stop the display sleeping while monitoring
  maxLog: 50,
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
