import { listSessions, getCounts, deleteSession, estimateUsage } from './shared/db.js';
import { buildSessionZip, downloadBlob, formatOffset, sessionFolderName } from './shared/export.js';

const list = document.getElementById('list');
const usage = document.getElementById('usage');

render();

async function render() {
  const sessions = await listSessions();
  const est = await estimateUsage();
  usage.textContent = est
    ? `ใช้พื้นที่ไปแล้ว ${mb(est.usage)} จากโควตา ${mb(est.quota)}`
    : '';

  list.replaceChildren();
  if (!sessions.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'ยังไม่มีบันทึก — เริ่มมอนิเตอร์โดยเปิดการอัดเสียงหรือจับสไลด์ แล้วกลับมาดูที่นี่';
    list.append(p);
    return;
  }
  for (const s of sessions) list.append(await card(s));
}

async function card(session) {
  const counts = await getCounts(session.id);
  const durationMs = (session.endedAt || Date.now()) - session.startedAt;

  const section = document.createElement('section');
  const row = document.createElement('div');
  row.className = 'session';

  const main = document.createElement('div');
  main.className = 'session-main';

  const h3 = document.createElement('h3');
  h3.textContent = session.tabTitle || 'ไม่ทราบชื่อแท็บ';
  main.append(h3);

  const meta = document.createElement('p');
  meta.className = 'muted';
  meta.textContent =
    `${new Date(session.startedAt).toLocaleString('th-TH')} · ยาว ${formatOffset(durationMs)}`
    + (session.endedAt ? '' : ' · ยังไม่จบ');
  main.append(meta);

  const chips = document.createElement('div');
  chips.className = 'chips';
  addChip(chips, `🔊 เสียง ${counts.chunks} ท่อน`, counts.chunks > 0);
  addChip(chips, session.micIncluded ? '🎙 มีไมโครโฟน' : '🎙 ไม่มีไมโครโฟน', !!session.micIncluded);
  addChip(chips, `🖼 สไลด์ ${counts.slides}`, counts.slides > 0);
  addChip(chips, `🔗 QR ${counts.qrHits}`, counts.qrHits > 0);
  main.append(chips);

  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('i');
  bar.append(fill);
  bar.hidden = true;
  main.append(bar);

  const status = document.createElement('p');
  status.className = 'muted';
  status.style.marginTop = '6px';
  main.append(status);

  const actions = document.createElement('div');
  actions.className = 'row';
  actions.style.marginTop = '0';
  actions.style.flexDirection = 'column';
  actions.style.alignItems = 'stretch';

  const exportBtn = document.createElement('button');
  exportBtn.className = 'secondary';
  exportBtn.textContent = 'ส่งออก ZIP';
  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    bar.hidden = false;
    try {
      const { blob, filename, stats } = await buildSessionZip(session.id, (step, pct) => {
        status.textContent = step;
        fill.style.width = `${Math.round(pct * 100)}%`;
      });
      downloadBlob(blob, filename);
      status.textContent =
        `✅ ${filename} · ${mb(stats.zipBytes)} · สไลด์ ${stats.slides} · QR ${stats.qrHits}`;
      status.className = 'ok';
    } catch (err) {
      status.textContent = `❌ ${String(err?.message || err)}`;
      status.className = 'bad';
    }
    bar.hidden = true;
    exportBtn.disabled = false;
  });

  const delBtn = document.createElement('button');
  delBtn.className = 'secondary';
  delBtn.textContent = 'ลบ';
  delBtn.addEventListener('click', async () => {
    // Deleting media is not undoable, so make the user say it twice.
    if (delBtn.dataset.armed !== '1') {
      delBtn.dataset.armed = '1';
      delBtn.textContent = 'กดอีกครั้งเพื่อลบถาวร';
      delBtn.classList.add('bad');
      setTimeout(() => {
        delBtn.dataset.armed = '0';
        delBtn.textContent = 'ลบ';
        delBtn.classList.remove('bad');
      }, 4000);
      return;
    }
    await deleteSession(session.id);
    await render();
  });

  actions.append(exportBtn, delBtn);
  row.append(main, actions);
  section.append(row);
  return section;
}

function addChip(parent, text, on) {
  const span = document.createElement('span');
  span.className = `chip${on ? ' on' : ''}`;
  span.textContent = text;
  parent.append(span);
}

function mb(bytes) {
  if (!bytes && bytes !== 0) return '—';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
