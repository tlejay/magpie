// Turns a recorded session into one ZIP the user can keep.
//
// The audio and the slides are only half the value — the other half is knowing
// which slide was on screen when something was said. timeline.md is what makes
// the archive navigable months later.

import { getSessionBundle } from './db.js';
import { formatOffset } from './format.js';

/** fflate is loaded as a classic script by whichever page calls this. */
function fflate() {
  if (!self.fflate) throw new Error('fflate ยังไม่ถูกโหลด');
  return self.fflate;
}

export { formatOffset };

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
 * One entry per track, MP3 preferred. WebM is used only for a track with no
 * MP3 — sessions recorded before the MP3 tap existed, or where it failed to
 * start. Handing over both would just double the download for no gain.
 *
 * @returns {Array<{track: string, format: 'mp3'|'webm', blob: Blob, ext: string, chunks: number}>}
 */
function assembleAudio(session, chunks) {
  const groups = new Map(); // track -> { mp3: [], webm: [] }
  for (const c of chunks) {
    const track = c.track || 'mix';
    const format = c.format === 'mp3' ? 'mp3' : 'webm';
    if (!groups.has(track)) groups.set(track, { mp3: [], webm: [] });
    groups.get(track)[format].push(c);
  }

  const out = [];
  for (const [track, g] of groups) {
    if (g.mp3.length) {
      out.push({
        track, format: 'mp3', ext: 'mp3', chunks: g.mp3.length,
        blob: new Blob(g.mp3.map((c) => c.blob), { type: 'audio/mpeg' }),
      });
    } else if (g.webm.length) {
      const type = session.audioMimeType || 'audio/webm';
      out.push({
        track, format: 'webm', ext: audioExtension(session.audioMimeType), chunks: g.webm.length,
        blob: new Blob(g.webm.map((c) => c.blob), { type }),
      });
    }
  }
  return out;
}

/**
 * Just the audio, no ZIP. Getting the recording out is the most common thing
 * anyone wants right after stopping, and making them build a whole archive for
 * it is friction for no reason.
 *
 * @returns {Promise<Array<{blob: Blob, filename: string, track: string}>>}
 */
export async function buildAudioFiles(sessionId) {
  const { session, chunks } = await getSessionBundle(sessionId);
  if (!session) throw new Error('ไม่พบ session นี้');
  if (!chunks.length) return [];

  const base = sessionFolderName(session);
  return assembleAudio(session, chunks).map((a) => ({
    track: a.track,
    format: a.format,
    blob: a.blob,
    filename: a.track === 'mix' ? `${base}.${a.ext}` : `${base}-${a.track}.${a.ext}`,
  }));
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
  const tree = {};

  // --- audio: one file per track, chunks concatenated in the order they were
  // produced. A 'mixed' session has a single 'mix' track; a 'separate' session
  // has 'tab' and 'mic'.
  let audioBytes = 0;
  const audioFiles = [];
  if (chunks.length) {
    onProgress('กำลังประกอบไฟล์เสียง', 0.2);
    for (const a of assembleAudio(session, chunks)) {
      const u8 = await blobToU8(a.blob);
      audioBytes += u8.length;
      const name = a.track === 'mix' ? `audio.${a.ext}` : `audio-${a.track}.${a.ext}`;
      // Already-compressed media — storing beats deflating on both speed and size.
      tree[name] = [u8, { level: 0 }];
      audioFiles.push({ name, track: a.track, format: a.format, bytes: u8.length, chunks: a.chunks });
    }
  }

  // --- slides
  onProgress('กำลังใส่ภาพสไลด์', 0.5);
  const slideFiles = {};
  let slideBytes = 0;
  let slidesOnDiscordOnly = 0;
  const slideNames = [];
  for (const [i, slide] of slides.entries()) {
    const name = `${String(i + 1).padStart(3, '0')}_${fileStamp(slide.offsetMs)}.jpg`;
    // A row with no blob was uploaded to Discord and its local bytes freed.
    // Keep it on the timeline pointing at Discord rather than dropping it.
    if (!slide.blob) {
      slidesOnDiscordOnly += 1;
      slideNames.push(null);
      continue;
    }
    const u8 = await blobToU8(slide.blob);
    slideBytes += u8.length;
    slideFiles[name] = [u8, { level: 0 }];
    slideNames.push(name);
  }
  if (Object.keys(slideFiles).length) tree.slides = slideFiles;

  // --- QR frames: the whole picture the code was read from. A bare URL in the
  // timeline is impossible to place months later; the slide it sat on is not.
  // Rows recorded before this existed have no blob and simply have no file.
  onProgress('กำลังใส่ภาพ QR', 0.65);
  const qrFiles = {};
  const qrNames = [];
  let qrBytes = 0;
  for (const [i, hit] of qrHits.entries()) {
    if (!hit.blob) { qrNames.push(null); continue; }
    const stamp = hit.offsetMs != null ? fileStamp(hit.offsetMs) : 'unknown';
    const name = `${String(i + 1).padStart(3, '0')}_${stamp}.jpg`;
    const u8 = await blobToU8(hit.blob);
    qrBytes += u8.length;
    qrFiles[name] = [u8, { level: 0 }];
    qrNames.push(name);
  }
  if (Object.keys(qrFiles).length) tree.qr = qrFiles;

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
      audioFiles: audioFiles.map((f) => ({ file: f.name, source: f.track, format: f.format, bytes: f.bytes })),
    },
    slides: slides.map((s, i) => ({
      seq: i + 1,
      offsetMs: s.offsetMs,
      at: formatOffset(s.offsetMs),
      file: slideNames[i] ? `slides/${slideNames[i]}` : null,
      discordUrl: s.discordUrl || null,
      changeRatio: s.ratio ?? null,
    })),
    qrCodes: qrHits.map((q, i) => ({
      offsetMs: q.offsetMs,
      at: q.offsetMs != null ? formatOffset(q.offsetMs) : null,
      text: q.text,
      url: q.url,
      file: qrNames[i] ? `qr/${qrNames[i]}` : null,
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
      slidesOnDiscordOnly,
      qrHits: qrHits.length,
      qrImages: Object.keys(qrFiles).length,
      qrBytes,
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
    ...meta.slides.map((s) => ({
      offsetMs: s.offsetMs,
      kind: 'slide',
      text: `🖼 สไลด์ ${String(s.seq).padStart(3, '0')} — `
        + (s.file ? `\`${s.file}\`` : (s.discordUrl ? `[ดูใน Discord](${s.discordUrl})` : '_ไม่มีไฟล์_')),
    })),
    ...meta.qrCodes.map((q) => ({
      offsetMs: q.offsetMs ?? 0,
      kind: 'qr',
      text: `🔗 QR — ${q.url || q.text}${q.file ? ` · \`${q.file}\`` : ''}`,
    })),
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
  const onDiscordOnly = meta.slides.filter((s) => !s.file).length;
  const qrWithFrame = meta.qrCodes.filter((q) => q.file).length;
  lines.push(`- **สไลด์:** ${meta.slides.length} ภาพ · **QR:** ${meta.qrCodes.length} รายการ`
    + (qrWithFrame ? ` (มีภาพหน้าจอ ${qrWithFrame} ภาพใน \`qr/\`)` : ''));
  if (onDiscordOnly) {
    lines.push(`- ⚠️ **${onDiscordOnly} ภาพไม่ได้อยู่ใน ZIP นี้** — ถูกส่งขึ้น Discord แล้วลบสำเนาในเครื่องทิ้ง`);
    lines.push('  ลิงก์ CDN ของ Discord หมดอายุประมาณ 24 ชม. แต่ตัวไฟล์ยังอยู่ในข้อความ');
    lines.push('  เปิดดูใน Discord ได้ตลอด (ลิงก์จะถูกต่ออายุให้เองตอนเปิด)');
  }
  lines.push('');

  // Only WebM carries the missing-duration quirk. MP3 is 16 kHz mono, ready
  // to hand straight to a transcription model.
  const webmFiles = audioFiles.filter((f) => f.format !== 'mp3');
  if (webmFiles.length) {
    lines.push('> ตัวอัดเสียงเขียนหัวไฟล์ตั้งแต่ก่อนรู้ความยาว ไฟล์จึงไม่มีข้อมูลความยาวติดมา');
    lines.push('> เปิดฟังได้ปกติ แต่ถ้าโปรแกรมไหนเลื่อนเวลาไม่ได้ ให้เขียนหัวไฟล์ใหม่ด้วยคำสั่งนี้ก่อน:');
    lines.push('>');
    lines.push('> ```bash');
    for (const f of webmFiles) {
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
