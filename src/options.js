import { getSettings, saveSettings, clearLog, clearSeen } from './shared/storage.js';

const el = (id) => document.getElementById(id);

// One declarative table instead of four parallel arrays. `toStore`/`fromStore`
// keep percentage sliders readable while the stored value stays a 0-1 fraction.
const FIELDS = [
  // --- Discord / QR
  { id: 'webhookUrl', kind: 'text' },
  { id: 'urlFilter', kind: 'text' },
  { id: 'urlBlocklist', kind: 'text' },
  { id: 'intervalSec', kind: 'range' },
  { id: 'cooldownMin', kind: 'range' },
  { id: 'soundEnabled', kind: 'check' },
  { id: 'volume', kind: 'range', toStore: (v) => v / 100, fromStore: (v) => Math.round(v * 100) },
  { id: 'attachSnapshot', kind: 'check' },

  // --- audio
  { id: 'audioLayout', kind: 'select' },
  { id: 'passthrough', kind: 'check' },
  { id: 'outputDeviceId', kind: 'select' },
  { id: 'recordTabAudio', kind: 'check' },
  { id: 'recordMic', kind: 'check' },
  { id: 'audioBitrateKbps', kind: 'select', toStore: Number },
  { id: 'chunkSeconds', kind: 'range' },

  // --- slides
  { id: 'slideIntervalSec', kind: 'range' },
  { id: 'changeThreshold', kind: 'range', toStore: (v) => v / 100, fromStore: (v) => Math.round(v * 100) },
  { id: 'blockDelta', kind: 'range' },
  { id: 'stabilityChecks', kind: 'range' },
  { id: 'slideQuality', kind: 'range', toStore: (v) => v / 100, fromStore: (v) => Math.round(v * 100) },
  { id: 'maxSlides', kind: 'range' },
  { id: 'slidesToDiscord', kind: 'check' },
  { id: 'slideDeleteLocalAfterUpload', kind: 'check' },

  // --- general
  { id: 'keepAwake', kind: 'check' },
  { id: 'maxLog', kind: 'range' },
];

init();

async function init() {
  await reportEngine();
  await load();
  await listOutputDevices();

  for (const f of FIELDS) {
    const node = el(f.id);
    if (!node) continue;
    node.addEventListener(f.kind === 'range' ? 'input' : 'change', () => {
      if (f.kind === 'range') syncLabels();
      persist();
    });
    if (f.kind === 'text') node.addEventListener('blur', persist);
  }

  for (const id of ['audioBitrateKbps', 'audioLayout', 'recordMic', 'recordTabAudio']) {
    el(id).addEventListener('change', updateSizeHint);
  }

  el('testWebhook').addEventListener('click', onTestWebhook);
  el('testSound').addEventListener('click', () => {
    const a = el('sample');
    a.volume = Number(el('volume').value) / 100;
    a.currentTime = 0;
    a.play().catch(() => {});
  });
  el('openPermission').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('src/permission.html') });
  });
  el('openSessions').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/sessions.html') });
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
  for (const f of FIELDS) {
    const node = el(f.id);
    if (!node) continue;
    const value = f.fromStore ? f.fromStore(s[f.id]) : s[f.id];
    if (f.kind === 'check') node.checked = !!value;
    else node.value = value ?? '';
  }
  syncLabels();
  updateSizeHint();
}

/** Every range has a <b id="<id>Label"> next to it. */
function syncLabels() {
  for (const f of FIELDS) {
    if (f.kind !== 'range') continue;
    const label = el(`${f.id}Label`);
    if (label) label.textContent = el(f.id).value;
  }
}

function updateSizeHint() {
  const kbps = Number(el('audioBitrateKbps').value) || 64;
  // Separate layout runs two recorders, so it costs twice the space.
  const streams = el('audioLayout').value === 'separate'
    && el('recordMic').checked && el('recordTabAudio').checked ? 2 : 1;
  const mbPerHour = ((kbps * 1000 * 3600) / 8 / 1024 / 1024) * streams;
  el('sizeHint').textContent =
    `ประมาณ ${mbPerHour.toFixed(0)} MB ต่อชั่วโมง — ประชุม 2 ชม. ราว ${(mbPerHour * 2).toFixed(0)} MB`
    + (streams === 2 ? ' (อัดสองชุด)' : '');
}

async function listOutputDevices() {
  const select = el('outputDeviceId');
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter((d) => d.kind === 'audiooutput');
    const current = select.value;
    for (const d of outputs) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      // Chrome hides device labels until microphone permission is granted.
      opt.textContent = d.label || '(ต้องอนุญาตไมโครโฟนก่อนถึงจะเห็นชื่อ)';
      select.append(opt);
    }
    const settings = await getSettings();
    select.value = settings.outputDeviceId || current || '';
  } catch {
    // Enumeration can fail outright; the default device still works.
  }
}

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    const patch = {};
    for (const f of FIELDS) {
      const node = el(f.id);
      if (!node) continue;
      let value;
      if (f.kind === 'check') value = node.checked;
      else if (f.kind === 'range') value = Number(node.value);
      else if (f.kind === 'text') value = node.value.trim();
      else value = node.value;
      patch[f.id] = f.toStore ? f.toStore(value) : value;
    }
    await saveSettings(patch);
    // A capture already in flight should pick up the new values immediately.
    chrome.runtime.sendMessage({ target: 'sw', type: 'APPLY_SETTINGS' }).catch(() => {});
    if (patch.outputDeviceId !== undefined) {
      chrome.runtime
        .sendMessage({ target: 'sw', type: 'SET_OUTPUT_DEVICE', deviceId: patch.outputDeviceId })
        .catch(() => {});
    }
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
