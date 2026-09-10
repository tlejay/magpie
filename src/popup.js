import { getState, getSettings, saveSettings, getLog } from './shared/storage.js';
import { listSessions, getCounts } from './shared/db.js';
import { buildAudioFiles, buildSessionZip, downloadBlob, formatOffset } from './shared/export.js';

const el = (id) => document.getElementById(id);
const TOOLS = ['enableQr', 'enableAudio', 'enableSlides'];

let currentTab = null;
let state = null;
let settings = null;
let levelTimer = null;
let lastSession = null; // most recent finished session, for the download block

init();

async function init() {
  const manifest = chrome.runtime.getManifest();
  el('version').textContent = manifest.version_name || manifest.version;
  el('version').title = 'เวอร์ชันที่โหลดอยู่จริง — ถ้าไม่ตรงกับที่คาด แปลว่ายังไม่ได้ Reload';

  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  el('toggle').addEventListener('click', onToggle);

  for (const id of TOOLS) {
    el(id).addEventListener('change', async () => {
      await saveSettings({ [id]: el(id).checked });
      await render();
    });
  }

  el('passthrough').addEventListener('change', async () => {
    const on = el('passthrough').checked;
    await saveSettings({ passthrough: on });
    // Applies to the running pipeline immediately — no restart needed.
    await send({ type: 'SET_PASSTHROUGH', on }).catch(() => {});
  });

  el('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  el('openSessions').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/sessions.html') });
  });
  el('dlAudio').addEventListener('click', () => downloadLast('audio'));
  el('dlZip').addEventListener('click', () => downloadLast('zip'));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.state || changes.log || changes.settings)) render();
  });

  await refreshLastSession();
  await render();
  setInterval(render, 5000); // keeps the elapsed labels honest
}

/**
 * Read the newest session straight from IndexedDB rather than only remembering
 * the one stopped in this popup — closing and reopening it should not lose the
 * way to get a recording out.
 */
async function refreshLastSession() {
  try {
    const [newest] = await listSessions();
    if (!newest) { lastSession = null; return; }
    const counts = await getCounts(newest.id);
    lastSession = (counts.chunks || counts.slides) ? { ...newest, counts } : null;
  } catch {
    lastSession = null; // a broken read must not take the whole popup down
  }
}

// ---------------------------------------------------------------- render

async function render() {
  state = await getState();
  settings = await getSettings();
  const log = await getLog();

  const monitoring = state.monitoring;
  const sameTab = monitoring && currentTab && state.tabId === currentTab.id;

  el('pill').textContent = monitoring ? (state.recording ? 'กำลังอัด' : 'กำลังเฝ้า') : 'หยุดอยู่';
  el('pill').className = `pill ${monitoring ? (state.recording ? 'rec' : 'on') : 'off'}`;

  // Tools decide what the capture asks Chrome for, which is fixed when the
  // stream opens — so they lock while a session is running.
  for (const id of TOOLS) {
    el(id).checked = !!settings[id];
    el(id).disabled = monitoring;
  }
  el('toolsNote').textContent = 'หยุดก่อนถึงจะเปลี่ยนได้';
  el('toolsNote').hidden = !monitoring;

  renderWarning(monitoring, sameTab);

  el('tabTitle').textContent = monitoring
    ? (state.tabTitle || 'ไม่ทราบชื่อแท็บ')
    : (currentTab?.title || 'ไม่ทราบชื่อแท็บ');

  const anyTool = TOOLS.some((id) => settings[id]);
  el('toggle').textContent = monitoring
    ? (sameTab ? 'หยุด' : 'หยุดแท็บนั้น')
    : 'เริ่มมอนิเตอร์แท็บนี้';
  el('toggle').classList.toggle('stop', monitoring);
  el('toggle').disabled = !monitoring && !anyTool;

  renderLive(monitoring);
  renderDone(monitoring);
  renderLog(log, monitoring);
}

function renderWarning(monitoring, sameTab) {
  const warn = el('warn');
  const show = (html) => { warn.innerHTML = html; warn.hidden = false; };

  // Ordered by urgency: something actively going wrong beats a setup reminder.
  if (state.lastError === 'noframes') {
    show('ยัง<b>ไม่ได้ภาพจากแท็บเลย</b> — สลับกลับไปให้แท็บประชุมเป็นแท็บที่เห็นอยู่ '
      + 'ถ้ายังไม่ขึ้น ให้หยุดแล้วเริ่มใหม่');
  } else if (state.slideBlank) {
    show('ภาพจากแท็บเป็นสีดำ — <b>ปิด Picture-in-Picture</b> แล้วภาพจะกลับมา '
      + 'ระหว่างนี้ไม่บันทึกสไลด์');
  } else if (state.audioNotice) {
    show(escapeHtml(state.audioNotice));
  } else if (settings.slidesToDiscord && !settings.webhookUrl) {
    show('เปิดส่งสไลด์เข้า Discord ไว้ แต่ยังไม่ได้ตั้ง webhook URL');
  } else if (settings.enableQr && !settings.webhookUrl) {
    show('ยังไม่ได้ตั้ง Discord webhook — จะเตือนบนเครื่องอย่างเดียว');
  } else if (monitoring && !sameTab) {
    show(`กำลังเฝ้าแท็บอื่นอยู่: <b>${escapeHtml(state.tabTitle || 'ไม่ทราบชื่อ')}</b>`);
  } else if (state.lastError === 'stalled') {
    show('ค้างอยู่ — ไม่ได้ภาพใหม่มาสักพัก ลองหยุดแล้วเริ่มใหม่');
  } else if (monitoring && !sendsToDiscord()) {
    // Audio never leaves the machine, so a slides/audio-only session with slide
    // upload off leaves the Discord channel silent — which reads as "broken".
    show('ตอนนี้<b>ไม่มีอะไรส่งเข้า Discord</b> — เก็บไว้ในเครื่องอย่างเดียว '
      + 'เปิด "เฝ้าหา QR" หรือ "ส่งสไลด์เข้า Discord" ใน ⚙ ตั้งค่า');
  } else if (!monitoring && !TOOLS.some((id) => settings[id])) {
    show('เปิดเครื่องมืออย่างน้อยหนึ่งอย่างก่อนถึงจะเริ่มได้');
  } else {
    warn.hidden = true;
  }
}

/** Whether anything in the running session will be posted to the webhook. */
function sendsToDiscord() {
  const qr = settings.enableQr && state.features?.qr;
  const slides = settings.slidesToDiscord && state.features?.slides;
  return !!(qr || slides);
}

function renderLive(monitoring) {
  el('live').hidden = !monitoring;
  clearInterval(levelTimer);
  levelTimer = null;
  if (!monitoring) return;

  // Inline metrics, not a grid of number cards — this is a status line, and a
  // status line should read as one sentence.
  const chips = [];
  if (state.startedAt) chips.push([formatOffset(Date.now() - state.startedAt), 'เฝ้ามาแล้ว']);
  if (state.features?.qr) {
    chips.push([state.scanCount ?? 0, 'สแกน']);
    if (state.filteredCount) chips.push([state.filteredCount, 'กรองทิ้ง']);
  }
  if (state.features?.slides) {
    chips.push([state.slideCount ?? 0, 'สไลด์']);
    if (settings.slidesToDiscord) chips.push([state.slidesUploaded ?? 0, 'ส่งแล้ว']);
  }
  if (state.features?.audio) chips.push([state.audioChunks ?? 0, 'ท่อนเสียง']);
  // The frame size answers "is it even seeing the tab" without opening a
  // console — 0×0 and 1280×720 are two completely different problems.
  if (state.features?.qr || state.features?.slides) {
    chips.push([state.frameW && state.frameH ? `${state.frameW}×${state.frameH}` : '0×0', 'ภาพ']);
  }

  el('metrics').replaceChildren(...chips.map(([value, label]) => {
    const span = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = String(value);
    span.append(b, document.createTextNode(label));
    return span;
  }));

  const recording = !!state.recording;
  el('audioPanel').hidden = !recording;
  if (!recording) return;

  el('passthrough').checked = settings.passthrough !== false;
  el('micLabel').textContent = state.micIncluded ? 'ไมค์' : 'ไมค์ (ไม่ได้ใช้)';
  levelTimer = setInterval(pollLevels, 250);
  pollLevels();
}

async function pollLevels() {
  const res = await send({ type: 'GET_LEVELS' }).catch(() => null);
  setMeter(el('mTab'), res?.levels?.tab);
  setMeter(el('mMic'), res?.levels?.mic);
}

function setMeter(node, value) {
  const level = Math.min(1, value ?? 0);
  node.style.transform = `scaleX(${level.toFixed(3)})`;
  node.classList.toggle('hot', level > 0.88);
}

function renderDone(monitoring) {
  const show = !monitoring && !!lastSession;
  el('lastSession').hidden = !show;
  if (!show) return;

  const c = lastSession.counts;
  const dur = (lastSession.endedAt || Date.now()) - lastSession.startedAt;
  const parts = [];
  if (c.chunks) parts.push(`🔊 เสียง ${formatOffset(dur)}`);
  if (c.slides) parts.push(`🖼 สไลด์ ${c.slides} ภาพ`);
  if (c.qrHits) parts.push(`🔗 QR ${c.qrHits}`);

  el('doneSummary').textContent = parts.join('  ·  ') || 'ไม่มีข้อมูล';
  el('doneWhen').textContent = lastSession.tabTitle ? ` · ${trim(lastSession.tabTitle, 22)}` : '';
  el('dlAudio').disabled = !c.chunks;
  el('dlZip').disabled = !(c.chunks || c.slides || c.qrHits);
}

function renderLog(log, monitoring) {
  // The QR history is noise when QR is not the tool in use.
  const show = settings.enableQr && (log.length || monitoring);
  el('logSection').hidden = !show;
  if (!show) return;

  const list = el('logList');
  list.replaceChildren();

  if (!log.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'ยังไม่เจอ QR';
    list.append(li);
    return;
  }

  for (const entry of log.slice(0, 10)) {
    const li = document.createElement('li');

    if (entry.thumb) {
      const img = document.createElement('img');
      img.src = entry.thumb;
      img.alt = '';
      li.append(img);
    }

    const body = document.createElement('div');
    body.className = 'entry-body';

    if (entry.url) {
      const a = document.createElement('a');
      a.textContent = entry.url;
      a.href = entry.url;
      a.title = entry.url;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: entry.url, active: true });
      });
      body.append(a);
    } else {
      const span = document.createElement('span');
      span.className = 'txt';
      span.textContent = entry.text;
      span.title = entry.text;
      body.append(span);
    }

    const meta = document.createElement('div');
    meta.className = 'entry-meta';
    const when = new Date(entry.ts).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    const how = { full: 'เต็มจอ', tiled: 'ซูมหา', inverted: 'กลับสี' }[entry.pass] || '';
    meta.append(document.createTextNode(`${when}${how ? ` · ${how}` : ''} `));
    if (entry.webhookOk === false) {
      const bad = document.createElement('span');
      bad.className = 'bad';
      bad.textContent = '· Discord ส่งไม่ผ่าน';
      bad.title = entry.webhookError || '';
      meta.append(bad);
    } else if (entry.webhookOk === true) {
      meta.append(document.createTextNode('· ส่ง Discord แล้ว'));
    }
    body.append(meta);

    li.append(body);
    list.append(li);
  }
}

// ---------------------------------------------------------------- actions

async function onToggle() {
  el('toggle').disabled = true;
  el('msg').textContent = '';
  try {
    if (state.monitoring) {
      await send({ type: 'STOP_MONITOR' });
      // This block is the answer to "where did the audio go" — fill it in the
      // instant the user stops, not on the next popup open.
      await refreshLastSession();
    } else {
      if (!currentTab) throw new Error('หาแท็บปัจจุบันไม่เจอ');
      if (/^(chrome|edge|about|chrome-extension):/.test(currentTab.url || '')) {
        throw new Error('แท็บระบบของ Chrome จับภาพไม่ได้ — เปิดหน้าประชุมในแท็บปกติก่อน');
      }
      // Must happen inside the popup's user gesture, then hand the id to the worker.
      const streamId = await getStreamId(currentTab.id);
      await send({
        type: 'START_MONITOR',
        streamId,
        tabId: currentTab.id,
        tabTitle: currentTab.title,
        tabUrl: currentTab.url,
      });
    }
  } catch (err) {
    el('msg').textContent = String(err.message || err).slice(0, 70);
  }
  await render();
}

async function downloadLast(kind) {
  if (!lastSession) return;
  [el('dlAudio'), el('dlZip')].forEach((b) => { b.disabled = true; });
  el('doneBar').hidden = false;
  setProgress(0.1);
  setStatus('กำลังเตรียมไฟล์…', null);

  try {
    if (kind === 'audio') {
      const files = await buildAudioFiles(lastSession.id);
      if (!files.length) throw new Error('ไม่มีไฟล์เสียงใน session นี้');
      setProgress(0.8);
      for (const f of files) downloadBlob(f.blob, f.filename);
      const total = files.reduce((n, f) => n + f.blob.size, 0);
      setStatus(`✅ ดาวน์โหลด ${files.length} ไฟล์ · ${mb(total)}`, true);
    } else {
      const { blob, filename, stats } = await buildSessionZip(lastSession.id, (step, pct) => {
        setStatus(step, null);
        setProgress(pct);
      });
      downloadBlob(blob, filename);
      setStatus(`✅ ${filename} · ${mb(stats.zipBytes)}`, true);
    }
  } catch (err) {
    setStatus(`❌ ${String(err?.message || err).slice(0, 80)}`, false);
  }

  el('doneBar').hidden = true;
  setProgress(0);
  renderDone(false);
}

// ---------------------------------------------------------------- helpers

function setProgress(fraction) {
  el('doneFill').style.transform = `scaleX(${Math.max(0, Math.min(1, fraction)).toFixed(3)})`;
}

function setStatus(text, ok) {
  const node = el('doneStatus');
  node.textContent = text;
  node.className = ok === null ? 'note' : ok ? 'note ok' : 'note bad';
}

function send(msg) {
  return chrome.runtime.sendMessage({ target: 'sw', ...msg }).then((res) => {
    if (!res || !res.ok) throw new Error(res?.error || 'ไม่มีการตอบกลับ');
    return res;
  });
}

function getStreamId(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(id);
    });
  });
}

function mb(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function trim(s, n) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
