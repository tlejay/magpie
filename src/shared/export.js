// Turns a recorded session into one ZIP the user can keep.
//
// The audio and the slides are only half the value — the other half is knowing
// which slide was on screen when something was said. timeline.md is what makes
// the archive navigable months later.

import { getSessionBundle } from './db.js';

/** fflate is loaded as a classic script by whichever page calls this. */
function fflate() {
  if (!self.fflate) throw new Error('fflate ยังไม่ถูกโหลด');
  return self.fflate;
}

export function formatOffset(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function fileStamp(ms) {
  return formatOffset(ms).replace(/:/g, '-');
}

export function sessionFolderName(session) {
  const d = new Date(session.startedAt);
  const pad = (n) => String(n).padStart(2, '0');
  return `magpie-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

async function blobToU8(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

function audioExtension(mimeType) {
  if (!mimeType) return 'webm';
  if (mimeType.includes('ogg')) return 'ogg';
  return 'webm';
}

/**
 * @param {string} sessionId
 * @param {(step: string, pct: number) => void} [onProgress]
 * @returns {Promise<{blob: Blob, filename: string, stats: object}>}
 */
export async function buildSessionZip(sessionId, onProgress = () => {}) {
  onProgress('กำลังอ่านข้อมูล', 0.05);
  const { session, chunks, slides, qrHits } = await getSessionBundle(sessionId);
  if (!session) throw new Error('ไม่พบ session นี้');

  const folder = sessionFolderName(session);
  const ext = audioExtension(session.audioMimeType);
  const tree = {};

  // --- audio: one file per track, chunks concatenated in the order the
  // recorder produced them. A 'mixed' session has a single 'mix' track;
  // a 'separate' session has 'tab' and 'mic'.
  let audioBytes = 0;
  const audioFiles = [];
  if (chunks.length) {
    onProgress('กำลังประกอบไฟล์เสียง', 0.2);
    const byTrack = new Map();
    for (const c of chunks) {
      const track = c.track || 'mix';
      if (!byTrack.has(track)) byTrack.set(track, []);
      byTrack.get(track).push(c);
    }
    for (const [track, list] of byTrack) {
      const blob = new Blob(list.map((c) => c.blob), { type: session.audioMimeType || 'audio/webm' });
      const u8 = await blobToU8(blob);
      audioBytes += u8.length;
      const name = track === 'mix' ? `audio.${ext}` : `audio-${track}.${ext}`;
      // Already-compressed media — storing beats deflating on both speed and size.
      tree[name] = [u8, { level: 0 }];
      audioFiles.push({ name, track, bytes: u8.length, chunks: list.length });
    }
  }

  // --- slides
  onProgress('กำลังใส่ภาพสไลด์', 0.5);
  const slideFiles = {};
  let slideBytes = 0;
  for (const [i, slide] of slides.entries()) {
    const u8 = await blobToU8(slide.blob);
    slideBytes += u8.length;
    const name = `${String(i + 1).padStart(3, '0')}_${fileStamp(slide.offsetMs)}.jpg`;
    slideFiles[name] = [u8, { level: 0 }];
  }
  if (slides.length) tree.slides = slideFiles;

  // --- machine-readable side-car
  onProgress('กำลังเขียนสารบัญ', 0.8);
  const meta = {
    session: {
      id: session.id,
      startedAt: new Date(session.startedAt).toISOString(),
      endedAt: session.endedAt ? new Date(session.endedAt).toISOString() : null,
      durationMs: (session.endedAt || Date.now()) - session.startedAt,
      tabTitle: session.tabTitle,
      tabUrl: session.tabUrl,
      features: session.features,
      audioMimeType: session.audioMimeType,
      audioLayout: session.audioLayout || 'mixed',
      micIncluded: session.micIncluded,
      audioFiles: audioFiles.map((f) => ({ file: f.name, source: f.track, bytes: f.bytes })),
    },
    slides: slides.map((s, i) => ({
      seq: i + 1,
      offsetMs: s.offsetMs,
      at: formatOffset(s.offsetMs),
      file: `slides/${String(i + 1).padStart(3, '0')}_${fileStamp(s.offsetMs)}.jpg`,
      changeRatio: s.ratio ?? null,
    })),
    qrCodes: qrHits.map((q) => ({
      offsetMs: q.offsetMs,
      at: q.offsetMs != null ? formatOffset(q.offsetMs) : null,
      text: q.text,
      url: q.url,
    })),
  };
  tree['session.json'] = fflate().strToU8(JSON.stringify(meta, null, 2));

  if (qrHits.length) {
    tree['qr-codes.json'] = fflate().strToU8(JSON.stringify(meta.qrCodes, null, 2));
  }

  tree['timeline.md'] = fflate().strToU8(buildTimeline(session, meta, { audioFiles }));

  onProgress('กำลังบีบเป็น ZIP', 0.9);
  const zipped = fflate().zipSync(tree, { level: 0 });
  onProgress('เสร็จแล้ว', 1);

  return {
    blob: new Blob([zipped], { type: 'application/zip' }),
    filename: `${folder}.zip`,
    stats: {
      slides: slides.length,
      qrHits: qrHits.length,
      audioChunks: chunks.length,
      audioFiles: audioFiles.length,
      audioBytes,
      slideBytes,
      zipBytes: zipped.length,
    },
  };
}

function buildTimeline(session, meta, { audioFiles }) {
  const started = new Date(session.startedAt);
  const events = [
    ...meta.slides.map((s) => ({ offsetMs: s.offsetMs, kind: 'slide', text: `🖼 สไลด์ ${String(s.seq).padStart(3, '0')} — \`${s.file}\`` })),
    ...meta.qrCodes.map((q) => ({ offsetMs: q.offsetMs ?? 0, kind: 'qr', text: `🔗 QR — ${q.url || q.text}` })),
  ].sort((a, b) => a.offsetMs - b.offsetMs);

  const lines = [];
  lines.push(`# ${session.tabTitle || 'บันทึกการประชุม'}`);
  lines.push('');
  lines.push(`- **เริ่ม:** ${started.toLocaleString('th-TH')}`);
  lines.push(`- **ความยาว:** ${formatOffset(meta.session.durationMs)}`);
  if (session.tabUrl) lines.push(`- **แท็บ:** ${session.tabUrl}`);
  const SOURCE_LABEL = {
    mix: session.micIncluded ? 'เสียงแท็บ + ไมโครโฟน' : 'เสียงแท็บอย่างเดียว',
    tab: 'เสียงจากแท็บ (คนอื่น)',
    mic: 'เสียงจากไมโครโฟนเรา',
  };
  for (const f of audioFiles) {
    lines.push(`- **ไฟล์เสียง:** \`${f.name}\` (${SOURCE_LABEL[f.track] || f.track})`);
  }
  lines.push(`- **สไลด์:** ${meta.slides.length} ภาพ · **QR:** ${meta.qrCodes.length} รายการ`);
  lines.push('');

  if (audioFiles.length) {
    lines.push('> ตัวอัดเสียงเขียนหัวไฟล์ตั้งแต่ก่อนรู้ความยาว ไฟล์จึงไม่มีข้อมูลความยาวติดมา');
    lines.push('> เปิดฟังได้ปกติ แต่ถ้าโปรแกรมไหนเลื่อนเวลาไม่ได้ ให้เขียนหัวไฟล์ใหม่ด้วยคำสั่งนี้ก่อน:');
    lines.push('>');
    lines.push('> ```bash');
    for (const f of audioFiles) {
      lines.push(`> ffmpeg -i ${f.name} -c copy fixed-${f.name}`);
    }
    lines.push('> ```');
    lines.push('');
  }

  lines.push('## ลำดับเหตุการณ์');
  lines.push('');
  if (!events.length) {
    lines.push('_ไม่มีเหตุการณ์ที่บันทึกไว้_');
  } else {
    lines.push('| เวลา | เกิดอะไร |');
    lines.push('|------|----------|');
    for (const e of events) {
      lines.push(`| ${formatOffset(e.offsetMs)} | ${e.text} |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** Save a Blob to disk from an extension page. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  // Give the download a moment to start before the URL is revoked.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
