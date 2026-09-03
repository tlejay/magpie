import { getState, getSettings, getLog } from './shared/storage.js';

const el = (id) => document.getElementById(id);
const ui = {
  pill: el('pill'), engine: el('engine'), warn: el('warn'),
  tabTitle: el('tabTitle'), toggle: el('toggle'), stats: el('stats'),
  scanCount: el('scanCount'), filteredCount: el('filteredCount'),
  lastScan: el('lastScan'), uptime: el('uptime'),
  logList: el('logList'), msg: el('msg'),
};

let currentTab = null;
let state = null;

init();

async function init() {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  ui.toggle.addEventListener('click', onToggle);
  el('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  el('openTest').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('test/qr-test.html') });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.state || changes.log || changes.settings)) render();
  });

  await render();
  setInterval(render, 5000); // keeps the "x นาทีที่แล้ว" labels honest
}

async function render() {
  state = await getState();
  const settings = await getSettings();
  const log = await getLog();

  const monitoring = state.monitoring;
  const sameTab = monitoring && currentTab && state.tabId === currentTab.id;

  ui.pill.textContent = monitoring ? 'กำลังเฝ้าอยู่' : 'หยุดอยู่';
  ui.pill.className = `pill ${monitoring ? 'on' : 'off'}`;

  ui.engine.textContent = monitoring
    ? `${state.engine === 'native' ? 'ตัวอ่านของระบบ' : 'jsQR (สำรอง)'} · ${state.frameW}×${state.frameH} · ทุก ${settings.intervalSec} วิ`
    : `สแกนทุก ${settings.intervalSec} วินาที`;

  // warnings
  if (!settings.webhookUrl) {
    showWarn('ยังไม่ได้ตั้ง Discord webhook — จะเด้งเตือนบนเครื่องอย่างเดียว <a href="#" id="w1">ไปตั้งค่า</a>');
    el('w1')?.addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
  } else if (monitoring && !sameTab) {
    showWarn(`กำลังเฝ้าแท็บอื่นอยู่: <b>${escapeHtml(state.tabTitle || 'ไม่ทราบชื่อ')}</b>`);
  } else if (state.lastError === 'stalled') {
    showWarn('มอนิเตอร์ค้าง — ไม่ได้ภาพใหม่มาสักพักแล้ว ลองหยุดแล้วเริ่มใหม่');
  } else {
    ui.warn.hidden = true;
  }

  ui.tabTitle.textContent = monitoring
    ? (state.tabTitle || 'ไม่ทราบชื่อแท็บ')
    : (currentTab?.title || 'ไม่ทราบชื่อแท็บ');

  ui.toggle.textContent = monitoring
    ? (sameTab ? 'หยุดมอนิเตอร์' : 'หยุดมอนิเตอร์แท็บนั้น')
    : 'เริ่มมอนิเตอร์แท็บนี้';
  ui.toggle.classList.toggle('stop', monitoring);
  ui.toggle.disabled = false;

  ui.stats.hidden = !monitoring;
  if (monitoring) {
    ui.scanCount.textContent = state.scanCount ?? 0;
    ui.filteredCount.textContent = state.filteredCount ?? 0;
    ui.lastScan.textContent = state.lastScanAt ? ago(state.lastScanAt) : '—';
    ui.uptime.textContent = state.startedAt ? duration(Date.now() - state.startedAt) : '—';
  }

  renderLog(log);
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
    meta.append(document.createTextNode(`${when} · ${entry.pass === 'full' ? 'เต็มจอ' : entry.pass === 'tiled' ? 'ซูมหา' : entry.pass === 'inverted' ? 'กลับสี' : ''} `));
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
      await send({ type: 'STOP_MONITOR' });
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
    ui.msg.textContent = String(err.message || err).slice(0, 80);
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
