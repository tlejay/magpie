// Orchestrator. Owns the offscreen document's lifecycle, the alerting rules,
// the Discord webhook, and the watchdog that catches a silently dead session.

import {
  getSettings, saveSettings, getState, setState, resetState,
  addLogEntry, updateLogEntry, getSeen, markSeen, DEFAULT_SETTINGS,
} from './shared/storage.js';
import { extractUrl, passesFilter, isBlocked } from './shared/qr.js';
import { putQrHit, markSlideUploaded, dropSlideBlob } from './shared/db.js';
import { formatOffset } from './shared/export.js';

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
// claiming we're still running. Left alone that's the worst possible failure:
// the user believes something is watching and recording when nothing is.
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
 * That file is gitignored, so the secret never reaches the repo but the user
 * also never has to paste it by hand.
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
    SLIDE_SAVED: () => handleSlideSaved(msg),
    SLIDE_BLANK: () => handleSlideBlank(),
    AUDIO_NOTICE: () => handleAudioNotice(msg),
    HEARTBEAT: () => handleHeartbeat(msg),
    CAPTURE_ENDED: () => handleCaptureLost(msg.reason || 'สัญญาณถูกตัด'),
    CAPTURE_ERROR: () => handleCaptureLost(msg.error || 'capture error'),
    TEST_WEBHOOK: () => testWebhook(msg.webhookUrl),
    APPLY_SETTINGS: () => applySettingsToCapture(),
    SET_PASSTHROUGH: () => proxyToOffscreen({ type: 'SET_PASSTHROUGH', on: msg.on }),
    SET_OUTPUT_DEVICE: () => proxyToOffscreen({ type: 'SET_OUTPUT_DEVICE', deviceId: msg.deviceId }),
    GET_LEVELS: () => proxyToOffscreen({ type: 'GET_LEVELS' }),
  };

  const fn = handlers[msg.type];
  if (!fn) return false;

  Promise.resolve()
    .then(fn)
    .then((result) => sendResponse({ ok: true, ...(result || {}) }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});

async function proxyToOffscreen(msg) {
  if (!(await hasOffscreen())) return { applied: false };
  const res = await sendToOffscreen(msg).catch(() => null);
  return res || { applied: false };
}

// ---------------------------------------------------------------- session

async function startMonitor({ streamId, tabId, tabTitle, tabUrl }) {
  if (!streamId) throw new Error('ไม่ได้ stream id จากแท็บ');

  const settings = await getSettings();
  const features = {
    qr: !!settings.enableQr,
    audio: !!settings.enableAudio,
    slides: !!settings.enableSlides,
  };
  if (!features.qr && !features.audio && !features.slides) {
    throw new Error('เปิดเครื่องมืออย่างน้อยหนึ่งอย่างก่อน');
  }
  await ensureOffscreen();

  const res = await sendToOffscreenReady({
    type: 'START_CAPTURE', streamId, settings, features, tabTitle, tabUrl,
  });
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
    filteredCount: 0,
    slideCount: 0,
    slidesUploaded: 0,
    audioChunks: 0,
    frameW: res.frameW || 0,
    frameH: res.frameH || 0,
    engine: res.engine || '',
    sessionId: res.sessionId || null,
    features,
    recording: !!res.recording,
    micIncluded: !!res.micIncluded,
    audioNotice: '',
    slideBlank: false,
    lastError: '',
  });

  if (settings.keepAwake) await requestKeepAwake();
  await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_MINUTES });
  await refreshBadge();

  return { sessionId: res.sessionId, engine: res.engine, recording: res.recording, micIncluded: res.micIncluded };
}

async function stopMonitor(reason) {
  let summary = null;
  if (await hasOffscreen()) {
    const res = await sendToOffscreen({ type: 'STOP_CAPTURE' }).catch(() => null);
    summary = res?.summary || null;
    await closeOffscreen();
  }
  await chrome.alarms.clear(WATCHDOG_ALARM);
  await releaseKeepAwake();
  await resetState();
  await setBadge('');
  return { reason, summary };
}

async function applySettingsToCapture() {
  const settings = await getSettings();
  const state = await getState();

  if (state.monitoring) {
    if (settings.keepAwake) await requestKeepAwake();
    else await releaseKeepAwake();
  }

  if (await hasOffscreen()) {
    // Only live-tunable values. Turning a whole tool on or off changes the
    // capture constraints, so that needs a restart, not a config push.
    await sendToOffscreen({
      type: 'UPDATE_CONFIG',
      config: {
        intervalSec: settings.intervalSec,
        attachSnapshot: settings.attachSnapshot,
        volume: settings.volume,
        passthrough: settings.passthrough,
        slideIntervalSec: settings.slideIntervalSec,
        blockDelta: settings.blockDelta,
        changeThreshold: settings.changeThreshold,
        stableThreshold: settings.stableThreshold,
        stabilityChecks: settings.stabilityChecks,
        slideQuality: settings.slideQuality,
        maxSlides: settings.maxSlides,
        // offscreen reads this to decide whether to encode the full-size
        // snapshot at all — without it, ticking the box mid-session did nothing.
        slidesToDiscord: settings.slidesToDiscord,
      },
    }).catch(() => {});
  }
  return { applied: true };
}

async function handleHeartbeat({ scanCount, slideCount, audioChunks, frameW, frameH }) {
  const state = await getState();
  if (!state.monitoring) return;
  await setState({
    scanCount: scanCount ?? state.scanCount,
    slideCount: slideCount ?? state.slideCount,
    audioChunks: audioChunks ?? state.audioChunks,
    lastScanAt: Date.now(),
    lastHeartbeatAt: Date.now(),
    frameW: frameW || state.frameW,
    frameH: frameH || state.frameH,
  });
}

/** The capture went black — tell the user what to actually do about it. */
async function handleSlideBlank() {
  const state = await getState();
  if (!state.monitoring || state.slideBlank) return;
  await setState({ slideBlank: true });
  await notifyPlain(
    'ภาพจากแท็บเป็นสีดำ',
    'มักเกิดจากการเปิด Picture-in-Picture — ภาพย้ายไปหน้าต่างลอย แท็บเลยว่างเปล่า\n'
    + 'ปิด PiP แล้วภาพจะกลับมาเอง · ระหว่างนี้ไม่มีการบันทึกสไลด์'
  );
  return { warned: true };
}

async function handleSlideSaved({ slideId, seq, offsetMs, snapshot }) {
  const state = await getState();
  if (!state.monitoring) return;
  await setState({ slideCount: seq ?? state.slideCount + 1, lastHeartbeatAt: Date.now() });

  const settings = await getSettings();
  if (!settings.slidesToDiscord || !settings.webhookUrl || !snapshot) return { seq, offsetMs };

  const result = await sendSlideToDiscord(settings, {
    snapshot, seq, offsetMs, tabTitle: state.tabTitle,
  });

  if (result.ok) {
    await setState({ slidesUploaded: (await getState()).slidesUploaded + 1 });
    if (slideId != null) {
      await markSlideUploaded(slideId, result.url).catch(() => {});
      // Only ever drop local bytes after Discord has confirmed it has a copy.
      if (settings.slideDeleteLocalAfterUpload) await dropSlideBlob(slideId).catch(() => {});
    }
  } else if (!state.slideUploadFailed) {
    // Tell the user once per session, not once per slide.
    await setState({ slideUploadFailed: true });
    await notifyPlain('ส่งสไลด์เข้า Discord ไม่สำเร็จ',
      `${result.error}\nภาพยังถูกเก็บไว้ในเครื่อง ส่งออกทีหลังได้`);
  }

  return { seq, offsetMs, uploaded: result.ok };
}

// A denied microphone or a failed sink must be visible. Silently producing a
// recording that is missing half the conversation is the worst outcome here.
async function handleAudioNotice({ code, detail }) {
  const messages = {
    'mic-unavailable': 'ใช้ไมโครโฟนไม่ได้ — กำลังอัดเฉพาะเสียงจากแท็บ',
    'sink-unavailable': 'เลือกลำโพงปลายทางไม่ได้ — ใช้ลำโพงค่าเริ่มต้นแทน',
    'chunk-write-failed': 'เขียนไฟล์เสียงลงเครื่องไม่สำเร็จ',
    'recorder-error': 'ตัวอัดเสียงมีปัญหา',
  };
  const message = messages[code] || `เสียงมีปัญหา: ${code}`;
  // setState spreads the patch, so an `undefined` value would wipe the stored
  // one — only include micIncluded when it actually changed.
  const patch = { audioNotice: message };
  if (code === 'mic-unavailable') patch.micIncluded = false;
  await setState(patch);
  await notifyPlain('Magpie', `${message}${detail ? `\n(${detail})` : ''}`);
  return { code };
}

async function handleCaptureLost(reason) {
  const state = await getState();
  if (!state.monitoring) return;
  const wasRecording = state.recording;
  await stopMonitor(reason);
  await notifyPlain(
    'หยุดทำงานแล้ว',
    `${reason}${wasRecording ? '\nไฟล์เสียงที่อัดไว้ถูกบันทึกไว้แล้ว' : ''}\nกดที่ไอคอน Magpie เพื่อเริ่มใหม่`
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
    await handleCaptureLost('สตรีมไม่ตอบสนอง');
    return;
  }

  await setState({
    lastHeartbeatAt: Date.now(),
    slideCount: pong.slideCount ?? state.slideCount,
    audioChunks: pong.audioChunks ?? state.audioChunks,
  });

  // Alive but not producing frames? Say so rather than pretending it's fine.
  const settings = await getSettings();
  if (state.features?.qr && state.lastScanAt) {
    const stallLimit = Math.max(settings.intervalSec * 3, 180) * 1000;
    if (Date.now() - state.lastScanAt > stallLimit) {
      await notifyPlain(
        'Magpie ค้าง',
        `ไม่ได้สแกนมา ${Math.round((Date.now() - state.lastScanAt) / 60000)} นาทีแล้ว — ลองหยุดแล้วเริ่มใหม่`
      );
      await setState({ lastError: 'stalled' });
    }
  }
});

// ---------------------------------------------------------------- QR handling

async function handleQrFound({ values, pass, scanCount, frameW, frameH, snapshot, thumb, offsetMs }) {
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
      id, ts: now, text: value, url, pass,
      thumb: thumb || null,
      tabTitle: state.tabTitle,
      webhookOk: null,
    });

    // Also record it against the session so it lands on the exported timeline.
    if (state.sessionId) {
      await putQrHit(state.sessionId, { text: value, url, offsetMs: offsetMs ?? null, pass })
        .catch(() => {});
    }

    await notifyQr(id, value, url);

    const result = await sendToDiscord(settings, {
      text: value, url,
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
  const domain = domainOf(url);
  const opts = {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('assets/icon128.png'),
    title: domain ? `QR Code Detected · ${domain}` : 'QR Code Detected',
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
  await refreshBadge();
}

chrome.notifications.onClicked.addListener(openNotificationTarget);
chrome.notifications.onButtonClicked.addListener((id, idx) => {
  if (idx === 0) openNotificationTarget(id);
});

// ---------------------------------------------------------------- Discord

async function sendToDiscord(settings, { text, url, snapshot, tabTitle, ts }) {
  if (!settings.webhookUrl) return { ok: false, error: 'ยังไม่ได้ตั้ง webhook URL' };

  const domain = domainOf(url);

  // State what was found; never guess what the link is for. An earlier version
  // called every QR a survey, which was wrong the first time it fired for real.
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
    content: `🔍 **QR Code Detected**${domain ? ` · ${domain}` : ''}${url ? `\n${url}` : ''}`,
    embeds: [embed],
  };

  return postWebhook(settings.webhookUrl, payload,
    snapshot ? { blob: dataUrlToBlob(snapshot), name: 'snapshot.jpg' } : null);
}

/** One slide, sent the moment it is captured. */
async function sendSlideToDiscord(settings, { snapshot, seq, offsetMs, tabTitle }) {
  const label = String(seq).padStart(3, '0');
  const name = `slide-${label}.jpg`;

  const result = await postWebhook(settings.webhookUrl, {
    username: 'Magpie',
    content: `🖼 **สไลด์ ${label}** · ${formatOffset(offsetMs)}`,
    embeds: [{
      color: 0xf59e0b,
      image: { url: `attachment://${name}` },
      footer: { text: tabTitle ? `จากแท็บ: ${tabTitle}`.slice(0, 2048) : 'Magpie' },
      timestamp: new Date().toISOString(),
    }],
  }, { blob: dataUrlToBlob(snapshot), name }, { wait: true });

  if (!result.ok) return result;

  // ?wait=true returns the created message. The uploaded file is consumed by the
  // embed's attachment:// reference, so Discord empties `attachments` and puts
  // the real CDN link on the embed instead — verified against a live webhook.
  const body = result.body;
  const url = body?.embeds?.[0]?.image?.url || body?.attachments?.[0]?.url || null;
  return { ok: true, url, messageId: body?.id || null };
}

/**
 * Multipart POST with one retry and 429 back-off.
 * `wait` asks Discord to return the created message instead of 204.
 */
async function postWebhook(webhookUrl, payload, file, { wait = false } = {}) {
  const url = wait
    ? `${webhookUrl}${webhookUrl.includes('?') ? '&' : '?'}wait=true`
    : webhookUrl;

  const build = () => {
    const fd = new FormData();
    fd.append('payload_json', JSON.stringify(payload));
    if (file) fd.append('files[0]', file.blob, file.name);
    return fd;
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', body: build() });
      if (res.ok) {
        return { ok: true, body: wait ? await res.json().catch(() => null) : null };
      }
      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        await sleep(Math.min(10_000, (body.retry_after || 1) * 1000 + 250));
        continue;
      }
      const body = await res.text().catch(() => '');
      if (attempt === 1) return { ok: false, error: `HTTP ${res.status} ${body.slice(0, 200)}` };
    } catch (err) {
      if (attempt === 1) return { ok: false, error: String(err?.message || err) };
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
      if (!/Receiving end does not exist|Could not establish connection/i.test(String(err?.message || err))) {
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

/** Red while recording, green while only watching — the difference matters. */
async function refreshBadge() {
  const state = await getState();
  if (!state.monitoring) return setBadge('');
  if (state.recording) return setBadge('REC', '#FF3B30');
  return setBadge('ON', '#1DB954');
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
