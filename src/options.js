import { getSettings, saveSettings, clearLog, clearSeen } from './shared/storage.js';

const el = (id) => document.getElementById(id);

const RANGES = [
  ['intervalSec', 'intervalLabel', (v) => v],
  ['cooldownMin', 'cooldownLabel', (v) => v],
  ['volume', 'volumeLabel', (v) => v],
  ['maxLog', 'maxLogLabel', (v) => v],
];
const CHECKS = ['soundEnabled', 'attachSnapshot', 'keepAwake'];
const TEXTS = ['webhookUrl', 'urlFilter', 'urlBlocklist'];

init();

async function init() {
  await reportEngine();
  await load();

  for (const [id] of RANGES) {
    el(id).addEventListener('input', () => { syncLabels(); persist(); });
  }
  for (const id of [...CHECKS, ...TEXTS]) {
    el(id).addEventListener('change', persist);
  }
  el('webhookUrl').addEventListener('blur', persist);

  el('testWebhook').addEventListener('click', onTestWebhook);
  el('testSound').addEventListener('click', () => {
    const a = el('sample');
    a.volume = Number(el('volume').value) / 100;
    a.currentTime = 0;
    a.play().catch(() => {});
  });
  el('clearLog').addEventListener('click', async () => {
    await clearLog();
    flash('clearResult', 'ล้างประวัติแล้ว', true);
  });
  el('clearSeen').addEventListener('click', async () => {
    await clearSeen();
    flash('clearResult', 'ล้างแล้ว — QR เดิมจะถูกเตือนอีกครั้ง', true);
  });
}

// Tell the user which decoder is actually going to run, rather than assuming.
async function reportEngine() {
  const note = el('engineNote');
  try {
    if (typeof BarcodeDetector === 'undefined') throw new Error('no BarcodeDetector');
    const formats = await BarcodeDetector.getSupportedFormats();
    if (!formats.includes('qr_code')) throw new Error('no qr_code format');
    note.textContent = '✅ ใช้ตัวอ่าน QR ของระบบ (เร็วและแม่นที่สุด) — ไม่ใช้ AI ไม่ต่อเน็ต';
    note.className = 'note ok';
  } catch {
    note.textContent = '⚠️ ระบบไม่มีตัวอ่าน QR ในตัว จะใช้ jsQR ที่ฝังมาแทน — ยังทำงานได้ แต่ช้ากว่าเล็กน้อย';
    note.className = 'note warn';
  }
}

async function load() {
  const s = await getSettings();
  el('webhookUrl').value = s.webhookUrl;
  el('urlFilter').value = s.urlFilter;
  el('urlBlocklist').value = s.urlBlocklist;
  el('intervalSec').value = s.intervalSec;
  el('cooldownMin').value = s.cooldownMin;
  el('volume').value = Math.round(s.volume * 100);
  el('maxLog').value = s.maxLog;
  for (const id of CHECKS) el(id).checked = !!s[id];
  syncLabels();
}

function syncLabels() {
  for (const [id, labelId, fmt] of RANGES) el(labelId).textContent = fmt(el(id).value);
}

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    const patch = {
      webhookUrl: el('webhookUrl').value.trim(),
      urlFilter: el('urlFilter').value.trim(),
      urlBlocklist: el('urlBlocklist').value.trim(),
      intervalSec: Number(el('intervalSec').value),
      cooldownMin: Number(el('cooldownMin').value),
      volume: Number(el('volume').value) / 100,
      maxLog: Number(el('maxLog').value),
    };
    for (const id of CHECKS) patch[id] = el(id).checked;
    await saveSettings(patch);
    // A capture already in flight should pick up the new interval immediately.
    chrome.runtime.sendMessage({ target: 'sw', type: 'APPLY_SETTINGS' }).catch(() => {});
    toast();
  }, 250);
}

async function onTestWebhook() {
  const url = el('webhookUrl').value.trim();
  el('testWebhook').disabled = true;
  flash('testResult', 'กำลังส่ง…', null);
  try {
    const res = await chrome.runtime.sendMessage({ target: 'sw', type: 'TEST_WEBHOOK', webhookUrl: url });
    if (!res || !res.ok) throw new Error(res?.error || 'ไม่มีการตอบกลับ');
    flash('testResult', '✅ ส่งแล้ว — ไปดูใน Discord ได้เลย', true);
  } catch (err) {
    flash('testResult', `❌ ${String(err.message || err).slice(0, 120)}`, false);
  }
  el('testWebhook').disabled = false;
}

function flash(id, text, ok) {
  const node = el(id);
  node.textContent = text;
  node.className = ok === null ? 'muted' : ok ? 'ok' : 'bad';
}

let toastTimer = null;
function toast() {
  const node = el('saved');
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 1200);
}
