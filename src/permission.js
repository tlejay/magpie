// Chrome will not show a getUserMedia prompt from an offscreen document, so a
// real page has to ask on its behalf. Once granted, the permission belongs to
// the extension origin and the offscreen document can open the mic silently.

import { getSettings, saveSettings } from './shared/storage.js';

const el = (id) => document.getElementById(id);

el('grant').addEventListener('click', async () => {
  el('grant').disabled = true;
  set('result', 'กำลังขอ…', null);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // We only needed the grant — release the device immediately so nothing
    // is holding the mic open after this page is closed.
    stream.getTracks().forEach((t) => t.stop());
    set('result', '✅ อนุญาตแล้ว — ปิดหน้านี้ได้เลย', true);
    await listMics();
  } catch (err) {
    set('result', `❌ ${err?.name === 'NotAllowedError' ? 'ถูกปฏิเสธ' : String(err?.message || err)}`, false);
  }
  el('grant').disabled = false;
});

el('save').addEventListener('click', async () => {
  await saveSettings({ micDeviceId: el('mic').value });
  set('saved', '✅ บันทึกแล้ว', true);
});

async function listMics() {
  const settings = await getSettings();
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = devices.filter((d) => d.kind === 'audioinput');

  el('mic').replaceChildren();
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'ตามค่าเริ่มต้นของระบบ';
  el('mic').append(auto);

  for (const d of mics) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    // Labels stay empty until the permission is granted — say so instead of
    // showing a list of blank rows.
    opt.textContent = d.label || '(ต้องอนุญาตก่อนถึงจะเห็นชื่อ)';
    el('mic').append(opt);
  }
  el('mic').value = settings.micDeviceId || '';
}

function set(id, text, ok) {
  const node = el(id);
  node.textContent = text;
  node.className = ok === null || ok === undefined ? 'muted' : ok ? 'ok' : 'bad';
}

listMics();
