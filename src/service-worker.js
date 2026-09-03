// Orchestrator. Owns the offscreen document's lifecycle, the alerting rules,
// the Discord webhook and the watchdog that catches a silently dead monitor.

import {
  getSettings, saveSettings, getState, setState, resetState,
  addLogEntry, updateLogEntry, getSeen, markSeen, DEFAULT_SETTINGS,
} from './shared/storage.js';
import { extractUrl, passesFilter, isBlocked } from './shared/qr.js';

const OFFSCREEN_PATH = 'src/offscreen.html';
const WATCHDOG_ALARM = 'magpie-watchdog';
const WATCHDOG_MINUTES = 2;
const MAX_ALERTS_PER_SCAN = 3; // a slide full of QRs shouldn't produce a wall of popups

// ---------------------------------------------------------------- lifecycle

chrome.runtime.onInstalled.addListener(async () => {
  await seedWebhookFromLocalConfig();
  await reconcileAfterRestart();
});

chrome.runtime.onStartup.addListener(reconcileAfterRestart);

// A browser restart kills the offscreen document but leaves our stored state
// claiming we're monitoring. Left alone that's the worst possible failure:
// Tle thinks a guard is watching when nothing is.
async function reconcileAfterRestart() {
  const state = await getState();
  if (!state.monitoring) return;
  if (await hasOffscreen()) return;
  await resetState();
  await setBadge('');
  await releaseKeepAwake();
}

/**
 * Pre-fill the webhook URL from src/config.local.js on first install.
 * That file is gitignored, so the secret never reaches the repo but Tle also
 * never has to paste it by hand.
 */
async function seedWebhookFromLocalConfig() {
  const settings = await getSettings();
  if (settings.webhookUrl) return;
  try {
    const res = await fetch(chrome.runtime.getURL('src/config.local.js'));
    if (!res.ok) return;
    const text = await res.text();
    const m = text.match(/DISCORD_WEBHOOK_URL\s*=\s*["'`]([^"'`]+)["'`]/);
    if (m && /^https:\/\/discord\.com\/api\/webhooks\//.test(m[1])) {
      await saveSettings({ webhookUrl: m[1] });
    }
  } catch {
    // No local config — the user will fill it in on the options page.
  }
}

// ---------------------------------------------------------------- messaging

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'sw') return false;

  const handlers = {
    START_MONITOR: () => startMonitor(msg),
    STOP_MONITOR: () => stopMonitor('user'),
    QR_FOUND: () => handleQrFound(msg),
    HEARTBEAT: () => handleHeartbeat(msg),
    CAPTURE_ENDED: () => handleCaptureLost(msg.reason || 'stream ended'),
    CAPTURE_ERROR: () => handleCaptureLost(msg.error || 'capture error'),
    TEST_WEBHOOK: () => testWebhook(msg.webhookUrl),
    APPLY_SETTINGS: () => applySettingsToCapture(),
  };

  const fn = handlers[msg.type];
  if (!fn) return false;

  Promise.resolve()
    .then(fn)
    .then((result) => sendResponse({ ok: true, ...(result || {}) }))
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
  return true;
});

// ---------------------------------------------------------------- monitoring

async function startMonitor({ streamId, tabId, tabTitle, tabUrl }) {
  if (!streamId) throw new Error('ไม่ได้ stream id จากแท็บ');

  await ensureOffscreen();
  const settings = await getSettings();

  const res = await sendToOffscreenReady({ type: 'START_CAPTURE', streamId, settings });
  if (!res || !res.ok) {
    await closeOffscreen();
    throw new Error(res?.error || 'เริ่ม capture ไม่สำเร็จ');
  }

  await setState({
    monitoring: true,
    tabId, tabTitle: tabTitle || '', tabUrl: tabUrl || '',
    startedAt: Date.now(),
    lastScanAt: null,
    lastHeartbeatAt: Date.now(),
    scanCount: 0,
    frameW: res.frameW || 0,
    frameH: res.frameH || 0,
    engine: res.engine || '',
    lastError: '',
  });

  if (settings.keepAwake) await requestKeepAwake();
  await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_MINUTES });
  await setBadge('ON', '#1DB954');

  return { engine: res.engine, frameW: res.frameW, frameH: res.frameH };
}

async function stopMonitor(reason) {
  if (await hasOffscreen()) {
    await sendToOffscreen({ type: 'STOP_CAPTURE' }).catch(() => {});
    await closeOffscreen();
  }
  await chrome.alarms.clear(WATCHDOG_ALARM);
  await releaseKeepAwake();
  await resetState();
  await setBadge('');
  return { reason };
}

async function applySettingsToCapture() {
  const settings = await getSettings();
  const state = await getState();

  if (state.monitoring) {
    if (settings.keepAwake) await requestKeepAwake();
    else await releaseKeepAwake();
  }

  if (await hasOffscreen()) {
    await sendToOffscreen({
      type: 'UPDATE_CONFIG',
      config: {
        intervalSec: settings.intervalSec,
        attachSnapshot: settings.attachSnapshot,
        volume: settings.volume,
      },
    }).catch(() => {});
  }
  return { applied: true };
}

async function handleHeartbeat({ scanCount, frameW, frameH }) {
  const state = await getState();
  if (!state.monitoring) return;
  await setState({
    scanCount: scanCount ?? state.scanCount,
    lastScanAt: Date.now(),
    lastHeartbeatAt: Date.now(),
    frameW: frameW || state.frameW,
    frameH: frameH || state.frameH,
  });
}

async function handleCaptureLost(reason) {
  const state = await getState();
  if (!state.monitoring) return;
  await stopMonitor(reason);
  await notifyPlain(
    'มอนิเตอร์หลุดแล้ว',
    `หยุดเฝ้าแท็บเพราะ: ${reason}\nกดที่ไอคอน extension เพื่อเริ่มใหม่`
  );
}

// The monitored tab going away is the most common way this breaks.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (state.monitoring && state.tabId === tabId) {
    await handleCaptureLost('แท็บที่เฝ้าอยู่ถูกปิด');
  }
});

// ---------------------------------------------------------------- watchdog

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== WATCHDOG_ALARM) return;
  const state = await getState();
  if (!state.monitoring) {
    await chrome.alarms.clear(WATCHDOG_ALARM);
    return;
  }

  if (!(await hasOffscreen())) {
    await handleCaptureLost('offscreen document หายไป');
    return;
  }

  const pong = await sendToOffscreen({ type: 'PING' }).catch(() => null);
  if (!pong || !pong.ok || !pong.running || !pong.live) {
    await handleCaptureLost('stream ไม่ตอบสนอง');
    return;
  }

  // Alive but not producing frames? Say so rather than pretending it's fine.
  const settings = await getSettings();
  const stallLimit = Math.max(settings.intervalSec * 3, 180) * 1000;
  if (state.lastScanAt && Date.now() - state.lastScanAt > stallLimit) {
    await notifyPlain(
      'มอนิเตอร์ค้าง',
      `ไม่ได้สแกนมา ${Math.round((Date.now() - state.lastScanAt) / 60000)} นาทีแล้ว — ลองกดหยุดแล้วเริ่มใหม่`
    );
    await setState({ lastError: 'stalled' });
  }
});

// ---------------------------------------------------------------- QR handling

async function handleQrFound({ values, pass, scanCount, frameW, frameH, snapshot, thumb }) {
  const settings = await getSettings();
  const state = await getState();
  const now = Date.now();

  await setState({
    scanCount: scanCount ?? state.scanCount,
    lastScanAt: now,
    lastHeartbeatAt: now,
    frameW: frameW || state.frameW,
    frameH: frameH || state.frameH,
  });

  const seen = await getSeen();
  const cooldownMs = Math.max(0, settings.cooldownMin) * 60_000;

  // Cooldown is checked FIRST, before the filters. A blocked QR sits on the
  // slide for minutes; filtering before deduping would count it again every
  // single scan and make the "filtered" figure meaningless.
  const fresh = [];
  let filtered = 0;
  for (const value of values) {
    if (seen[value] && now - seen[value] < cooldownMs) continue;

    if (isBlocked(value, settings.urlBlocklist) || !passesFilter(value, settings.urlFilter)) {
      filtered += 1;
      await markSeen(value, now); // remember it so it isn't re-counted next scan
      continue;
    }
    fresh.push(value);
  }

  if (filtered) {
    await setState({ filteredCount: (await getState()).filteredCount + filtered });
  }

  if (!fresh.length) return { alerted: 0, filtered };

  const toAlert = fresh.slice(0, MAX_ALERTS_PER_SCAN);
  for (const value of toAlert) await markSeen(value, now);

  if (settings.soundEnabled) {
    await sendToOffscreen({ type: 'PLAY_SOUND', volume: settings.volume }).catch(() => {});
  }
  await setBadge('!', '#FF3B30');

  for (const value of toAlert) {
    const url = extractUrl(value);
    const id = `qr_${now}_${Math.random().toString(36).slice(2, 8)}`;

    await addLogEntry({
      id,
      ts: now,
      text: value,
      url,
      pass,
      thumb: thumb || null,
      tabTitle: state.tabTitle,
      webhookOk: null,
    });

    await notifyQr(id, value, url);

    const result = await sendToDiscord(settings, {
      text: value,
      url,
      snapshot: settings.attachSnapshot ? snapshot : null,
      tabTitle: state.tabTitle,
      ts: now,
    });
    await updateLogEntry(id, { webhookOk: result.ok, webhookError: result.error || null });
  }

  return { alerted: toAlert.length, filtered };
}

// ---------------------------------------------------------------- notifications

async function notifyQr(id, text, url) {
  const opts = {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('assets/icon128.png'),
    title: 'QR Code Detected',
    message: url || text.slice(0, 300),
    contextMessage: 'Magpie',
    priority: 2,
    requireInteraction: true, // stays on screen until acknowledged — that's the point
  };
  if (url) opts.buttons = [{ title: 'เปิดลิงก์' }];

  await chrome.notifications.create(id, opts);
  if (url) {
    const { notifUrls = {} } = await chrome.storage.session.get('notifUrls');
    notifUrls[id] = url;
    await chrome.storage.session.set({ notifUrls });
  }
}

async function notifyPlain(title, message) {
  await chrome.notifications.create(`sys_${Date.now()}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('assets/icon128.png'),
    title,
    message,
    contextMessage: 'Magpie',
    priority: 2,
  });
}

async function openNotificationTarget(notificationId) {
  const { notifUrls = {} } = await chrome.storage.session.get('notifUrls');
  const url = notifUrls[notificationId];
  if (!url) return;
  await chrome.tabs.create({ url, active: true });
  delete notifUrls[notificationId];
  await chrome.storage.session.set({ notifUrls });
  await chrome.notifications.clear(notificationId);
  await setBadge((await getState()).monitoring ? 'ON' : '', '#1DB954');
}

chrome.notifications.onClicked.addListener(openNotificationTarget);
chrome.notifications.onButtonClicked.addListener((id, idx) => {
  if (idx === 0) openNotificationTarget(id);
});

// ---------------------------------------------------------------- Discord

async function sendToDiscord(settings, { text, url, snapshot, tabTitle, ts }) {
  if (!settings.webhookUrl) return { ok: false, error: 'ยังไม่ได้ตั้ง webhook URL' };

  const embed = {
    title: 'QR Code Detected',
    description: '```\n' + text.slice(0, 1500) + '\n```',
    color: 0xf59e0b,
    timestamp: new Date(ts).toISOString(),
    footer: { text: tabTitle ? `จากแท็บ: ${tabTitle}`.slice(0, 2048) : 'Magpie' },
  };
  if (url) embed.url = url;
  if (snapshot) embed.image = { url: 'attachment://snapshot.jpg' };

  const payload = {
    username: 'Magpie',
    content: `🔍 **QR Code Detected**${domainOf(url) ? ` · ${domainOf(url)}` : ''}${url ? `\n${url}` : ''}`,
    embeds: [embed],
  };

  const build = () => {
    const fd = new FormData();
    fd.append('payload_json', JSON.stringify(payload));
    if (snapshot) fd.append('files[0]', dataUrlToBlob(snapshot), 'snapshot.jpg');
    return fd;
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(settings.webhookUrl, { method: 'POST', body: build() });
      if (res.ok) return { ok: true };
      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        await sleep(Math.min(10_000, (body.retry_after || 1) * 1000 + 250));
        continue;
      }
      const body = await res.text().catch(() => '');
      if (attempt === 1) return { ok: false, error: `HTTP ${res.status} ${body.slice(0, 200)}` };
    } catch (err) {
      if (attempt === 1) return { ok: false, error: String(err && err.message || err) };
    }
    await sleep(1500);
  }
  return { ok: false, error: 'ส่งไม่สำเร็จหลังลอง 2 ครั้ง' };
}

async function testWebhook(overrideUrl) {
  const settings = await getSettings();
  const webhookUrl = overrideUrl || settings.webhookUrl;
  if (!webhookUrl) throw new Error('ยังไม่ได้ใส่ webhook URL');

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'Magpie',
      content: '✅ **Magpie connected** — พร้อมเฝ้าแท็บให้แล้ว',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return { sent: true };
}

// ---------------------------------------------------------------- offscreen glue

let creating = null; // guards against two concurrent createDocument calls

async function hasOffscreen() {
  if (chrome.offscreen?.hasDocument) return chrome.offscreen.hasDocument();
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creating) return creating;
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Hold the captured tab stream and analyse frames locally.',
  });
  try {
    await creating;
  } finally {
    creating = null;
  }
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => {});
}

function sendToOffscreen(msg) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
}

// createDocument() can resolve a beat before offscreen.js has registered its
// onMessage listener, and the first message then vanishes with
// "Receiving end does not exist". Retry briefly instead of failing the start.
async function sendToOffscreenReady(msg, attempts = 8) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await sendToOffscreen(msg);
    } catch (err) {
      lastErr = err;
      if (!/Receiving end does not exist|Could not establish connection/i.test(String(err.message || err))) {
        throw err;
      }
      await sleep(120);
    }
  }
  throw lastErr || new Error('offscreen document ไม่ตอบสนอง');
}

// ---------------------------------------------------------------- misc helpers

async function requestKeepAwake() {
  try { chrome.power.requestKeepAwake('display'); } catch { /* non-fatal */ }
}
async function releaseKeepAwake() {
  try { chrome.power.releaseKeepAwake(); } catch { /* non-fatal */ }
}

async function setBadge(text, color) {
  await chrome.action.setBadgeText({ text });
  if (color) await chrome.action.setBadgeBackgroundColor({ color });
}

/** Bare hostname for the alert line, so a phone notification is triageable at a glance. */
function domainOf(url) {
  try {
    // Non-http payloads like "WIFI:S:Net;;" parse without throwing but have no
    // hostname, so an empty result has to be normalised to null here.
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host || null;
  } catch {
    return null;
  }
}

function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const mime = (head.match(/:(.*?);/) || [, 'image/jpeg'])[1];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export { DEFAULT_SETTINGS };
