import { getState, getSettings, saveSettings, getLog } from './shared/storage.js';

const el = (id) => document.getElementById(id);
const TOOLS = ['enableQr', 'enableAudio', 'enableSlides'];

const ui = {
  pill: el('pill'), engine: el('engine'), warn: el('warn'),
  toolsNote: el('toolsNote'), tabTitle: el('tabTitle'), toggle: el('toggle'),
  stats: el('stats'), logList: el('logList'), msg: el('msg'),
  audioPanel: el('audioPanel'), passthrough: el('passthrough'),
  mTab: el('mTab'), mMic: el('mMic'), micLabel: el('micLabel'),
};

let currentTab = null;
let state = null;
let settings = null;
let levelTimer = null;

init();

async function init() {
  const manifest = chrome.runtime.getManifest();
  el('version').textContent = manifest.version_name || manifest.version;
  el('version').title = 'เวอร์ชันที่โหลดอยู่จริง — ถ้าไม่ตรงกับที่คาด แปลว่ายังไม่ได้ Reload';

  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  ui.toggle.addEventListener('click', onToggle);

  for (const id of TOOLS) {
    el(id).addEventListener('change', async () => {
      await saveSettings({ [id]: el(id).checked });
      await render();
    });
  }

  ui.passthrough.addEventListener('change', async () => {
    const on = ui.passthrough.checked;
    await saveSettings({ passthrough: on });
    // Applies to the running pipeline immediately — no restart needed.
    await send({ type: 'SET_PASSTHROUGH', on }).catch(() => {});
  });

  el('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  el('openSessions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('src/sessions.html') });
  });
  el('openTest').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('test/qr-test.html') });
  });
  el('openSlideTest').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('test/slide-test.html') });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.state || changes.log || changes.settings)) render();
  });

  await render();
  setInterval(render, 5000); // keeps the "x นาทีที่แล้ว" labels honest
}

async function render() {
  state = await getState();
  settings = await getSettings();
  const log = await getLog();

  const monitoring = state.monitoring;
  const sameTab = monitoring && currentTab && state.tabId === currentTab.id;

  ui.pill.textContent = monitoring ? (state.recording ? 'กำลังอัด' : 'กำลังเฝ้าอยู่') : 'หยุดอยู่';
  ui.pill.className = `pill ${monitoring ? (state.recording ? 'rec' : 'on') : 'off'}`;

  ui.engine.textContent = monitoring
    ? describeRunning()
    : 'เก็บสิ่งที่การประชุมทิ้งไว้';

  // Tools cannot be switched mid-session: they change what the capture asks
  // Chrome for, which is decided once when the stream opens.
  for (const id of TOOLS) {
    el(id).checked = !!settings[id];
    el(id).disabled = monitoring;
  }
  ui.toolsNote.textContent = monitoring ? 'หยุดก่อนถึงจะเปลี่ยนได้' : '';

  renderWarning(monitoring, sameTab);

  ui.tabTitle.textContent = monitoring
    ? (state.tabTitle || 'ไม่ทราบชื่อแท็บ')
    : (currentTab?.title || 'ไม่ทราบชื่อแท็บ');

  const anyTool = TOOLS.some((id) => settings[id]);
  ui.toggle.textContent = monitoring
    ? (sameTab ? 'หยุด' : 'หยุดแท็บนั้น')
    : 'เริ่มมอนิเตอร์แท็บนี้';
  ui.toggle.classList.toggle('stop', monitoring);
  ui.toggle.disabled = !monitoring && !anyTool;

  renderAudio(monitoring);
  renderStats(monitoring);
  renderLog(log);
}

function describeRunning() {
  const on = [];
  if (state.features?.qr) on.push('QR');
  if (state.features?.audio) on.push(state.micIncluded ? 'เสียง+ไมค์' : 'เสียง');
  if (state.features?.slides) on.push('สไลด์');
  const size = state.frameW ? ` · ${state.frameW}×${state.frameH}` : '';
  return `${on.join(' · ') || '—'}${size}`;
}

function renderWarning(monitoring, sameTab) {
  if (state.audioNotice) {
    showWarn(escapeHtml(state.audioNotice));
  } else if (settings.enableQr && !settings.webhookUrl) {
    showWarn('ยังไม่ได้ตั้ง Discord webhook — จะเด้งเตือนบนเครื่องอย่างเดียว <a href="#" id="w1">ไปตั้งค่า</a>');
    el('w1')?.addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
  } else if (monitoring && !sameTab) {
    showWarn(`กำลังเฝ้าแท็บอื่นอยู่: <b>${escapeHtml(state.tabTitle || 'ไม่ทราบชื่อ')}</b>`);
  } else if (settings.slidesToDiscord && !settings.webhookUrl) {
    showWarn('ติ๊ก "ส่งสไลด์เข้า Discord" ไว้ แต่ยังไม่ได้ตั้ง webhook URL');
  } else if (monitoring && settings.enableSlides && !settings.slidesToDiscord) {
    showWarn('สไลด์ถูกเก็บลงเครื่องอย่างเดียว — ยังไม่ได้เปิด "ส่งสไลด์เข้า Discord" ใน <a href="#" id="w2">ตั้งค่า</a>');
    el('w2')?.addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
  } else if (state.lastError === 'stalled') {
    showWarn('ค้างอยู่ — ไม่ได้ภาพใหม่มาสักพักแล้ว ลองหยุดแล้วเริ่มใหม่');
  } else if (!monitoring && !TOOLS.some((id) => settings[id])) {
    showWarn('เปิดเครื่องมืออย่างน้อยหนึ่งอย่างก่อนถึงจะเริ่มได้');
  } else {
    ui.warn.hidden = true;
  }
}

function renderAudio(monitoring) {
  const live = monitoring && state.recording;
  ui.audioPanel.hidden = !live;
  clearInterval(levelTimer);
  levelTimer = null;
  if (!live) return;

  ui.passthrough.checked = settings.passthrough !== false;
  ui.micLabel.textContent = state.micIncluded ? 'ไมค์' : 'ไมค์ (ไม่ได้ใช้)';

  levelTimer = setInterval(pollLevels, 250);
  pollLevels();
}

async function pollLevels() {
  const res = await send({ type: 'GET_LEVELS' }).catch(() => null);
  const levels = res?.levels;
  setMeter(ui.mTab, levels?.tab);
  setMeter(ui.mMic, levels?.mic);
}

function setMeter(node, value) {
  const pct = Math.round(Math.min(1, value ?? 0) * 100);
  node.style.width = `${pct}%`;
  node.classList.toggle('hot', pct > 88);
}

function renderStats(monitoring) {
  ui.stats.hidden = !monitoring;
  if (!monitoring) return;

  const cells = [];
  if (state.features?.qr) {
    cells.push(['สแกนแล้ว', state.scanCount ?? 0]);
    cells.push(['กรองทิ้ง', state.filteredCount ?? 0]);
  }
  if (state.features?.slides) {
    // Showing the upload count next to the capture count turns "nothing arrived
    // in Discord" from a guess into something you can read off the popup.
    cells.push(settings.slidesToDiscord
      ? ['สไลด์ · ส่งแล้ว', `${state.slideCount ?? 0} · ${state.slidesUploaded ?? 0}`]
      : ['สไลด์', state.slideCount ?? 0]);
  }
  if (state.features?.audio) cells.push(['เสียง', `${state.audioChunks ?? 0} ท่อน`]);
  cells.push(['เฝ้ามาแล้ว', state.startedAt ? duration(Date.now() - state.startedAt) : '—']);
  if (state.features?.qr) cells.push(['สแกนล่าสุด', state.lastScanAt ? ago(state.lastScanAt) : '—']);

  ui.stats.replaceChildren();
  for (const [label, value] of cells) {
    const div = document.createElement('div');
    const span = document.createElement('span');
    span.textContent = String(value);
    const small = document.createElement('small');
    small.textContent = label;
    div.append(span, small);
    ui.stats.append(div);
  }
}

function showWarn(html) {
  ui.warn.innerHTML = html;
  ui.warn.hidden = false;
}

function renderLog(log) {
  ui.logList.replaceChildren();
  if (!log.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'ยังไม่เจอ QR';
    ui.logList.append(li);
    return;
  }

  for (const entry of log.slice(0, 12)) {
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
    ui.logList.append(li);
  }
}

async function onToggle() {
  ui.toggle.disabled = true;
  ui.msg.textContent = '';
  try {
    if (state.monitoring) {
      const res = await send({ type: 'STOP_MONITOR' });
      const s = res.summary;
      if (s?.chunks || s?.slides) {
        ui.msg.textContent = `บันทึกแล้ว: เสียง ${s.chunks || 0} ท่อน · สไลด์ ${s.slides || 0}`;
      }
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
    ui.msg.textContent = String(err.message || err).slice(0, 90);
  }
  await render();
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

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s} วิ`;
  if (s < 3600) return `${Math.round(s / 60)} นาที`;
  return `${Math.round(s / 3600)} ชม.`;
}

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} นาที`;
  return `${Math.floor(m / 60)} ชม. ${m % 60} น.`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
