// The "virtual speaker": tab audio keeps playing out of the real speakers while
// a copy of it — with or without the microphone mixed in — is recorded to disk.
//
// Two rules govern this whole file, and breaking either one ruins a meeting:
//
//   1. Capturing tab audio MUTES the tab. Chrome hands you the stream and stops
//      playing it. Passthrough is not a feature, it is a repair — without it the
//      user sits through a silent meeting.
//   2. The microphone must NEVER reach ctx.destination. Tab audio -> speakers is
//      fine; mic -> speakers is a feedback loop into the user's own ears.
//
//   mixed layout                        separate layout
//   ────────────                        ───────────────
//   tab ─┬─(pass)→ speakers             tab ─┬─(pass)→ speakers
//        └────────┐                          └────────→ [tab recorder]
//   mic ──────────┴→ [one recorder]     mic ───────────→ [mic recorder]
//
// Every recorder also has an MP3 tap beside it. MediaRecorder can only write
// WebM/Opus in practice — Chrome claims audio/mp4 AAC but hands back zero bytes —
// and WebM is what LLM and transcription tools refuse most often. The tap
// encodes 16 kHz mono MP3 live and stores it next to the WebM, so exporting
// never has to decode an hour of audio in one go. The WebM stays as a fallback.

const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
];

const RAMP_SECONDS = 0.015; // short fade so toggling passthrough doesn't click

const MP3_KBPS = 32; // 16 kHz mono speech: ~14 MB an hour, under Whisper's 25 MB up to ~1.7 h

export const TRACK = { MIX: 'mix', TAB: 'tab', MIC: 'mic' };

export function pickMimeType() {
  for (const type of PREFERRED_MIME_TYPES) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

/**
 * @param {object}   opts
 * @param {MediaStream} opts.tabStream   stream from tabCapture (must contain an audio track)
 * @param {object}   opts.settings       audio settings from storage
 * @param {Function} opts.onChunk        (blob, seq, offsetMs, track, format) => Promise — persist immediately
 * @param {Function} opts.onNotice       (code, detail) => void — non-fatal problems worth telling the user
 */
export async function createAudioPipeline({ tabStream, settings, onChunk, onNotice }) {
  const tabTrack = tabStream.getAudioTracks()[0];
  if (!tabTrack) throw new Error('ไม่มี audio track ในสตรีมของแท็บ');

  const layout = settings.audioLayout === 'separate' ? 'separate' : 'mixed';
  const wantTab = settings.recordTabAudio !== false;

  const ctx = new AudioContext();
  if (ctx.state === 'suspended') await ctx.resume();

  const tabSource = ctx.createMediaStreamSource(new MediaStream([tabTrack]));

  // --- passthrough: the repair for Chrome muting the captured tab
  const passthroughGain = ctx.createGain();
  passthroughGain.gain.value = settings.passthrough === false ? 0 : 1;
  tabSource.connect(passthroughGain);
  passthroughGain.connect(ctx.destination);

  const tabRecordGain = ctx.createGain();
  tabRecordGain.gain.value = wantTab ? 1 : 0;
  tabSource.connect(tabRecordGain);

  const tabAnalyser = ctx.createAnalyser();
  tabAnalyser.fftSize = 512;
  tabSource.connect(tabAnalyser);

  // --- microphone (optional, and allowed to fail)
  let micStream = null;
  let micGain = null;
  let micAnalyser = null;

  if (settings.recordMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: settings.micDeviceId
          ? { deviceId: { exact: settings.micDeviceId } }
          : true,
      });
      const micSource = ctx.createMediaStreamSource(micStream);
      micGain = ctx.createGain();
      micGain.gain.value = 1;
      micSource.connect(micGain); // deliberately never connected to ctx.destination

      micAnalyser = ctx.createAnalyser();
      micAnalyser.fftSize = 512;
      micSource.connect(micAnalyser);
    } catch (err) {
      // Recording without the mic is still useful — but say so out loud rather
      // than handing back a file that is quietly missing half the conversation.
      onNotice?.('mic-unavailable', String(err?.name || err));
    }
  }

  // ---------------------------------------------------------------- recorders

  const mimeType = pickMimeType();
  const startedAt = Date.now();
  const timeslice = Math.max(1000, (settings.chunkSeconds || 5) * 1000);
  const recorders = [];
  const mp3Taps = [];
  let pending = Promise.resolve();

  // The MP3 copy is a convenience, never a reason to fail a recording.
  let mp3Ready = false;
  try {
    if (!self.lamejs) throw new Error('lamejs ยังไม่ถูกโหลด');
    await ctx.audioWorklet.addModule(new URL('./pcm-tap.worklet.js', import.meta.url));
    mp3Ready = true;
  } catch (err) {
    onNotice?.('mp3-unavailable', String(err?.message || err));
  }

  function addMp3Tap(track, sourceNode) {
    if (!mp3Ready) return;
    try {
      mp3Taps.push(createMp3Tap({ ctx, sourceNode, track, startedAt, timeslice, onChunk, onNotice }));
    } catch (err) {
      onNotice?.('mp3-unavailable', `${track}: ${String(err?.message || err)}`);
    }
  }

  function addRecorder(track, destination) {
    const recorder = new MediaRecorder(destination.stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: (settings.audioBitrateKbps || 64) * 1000,
    });
    const entry = { track, recorder, seq: 0 };

    recorder.ondataavailable = (event) => {
      if (!event.data || !event.data.size) return;
      const mySeq = entry.seq++;
      const offsetMs = Date.now() - startedAt;
      // Chain the writes so chunks reach storage in order even if IndexedDB is slow.
      pending = pending
        .then(() => onChunk(event.data, mySeq, offsetMs, track, 'webm'))
        .catch((err) => onNotice?.('chunk-write-failed', String(err?.message || err)));
    };
    recorder.onerror = (event) =>
      onNotice?.('recorder-error', `${track}: ${String(event?.error?.name || 'unknown')}`);

    recorder.start(timeslice);
    recorders.push(entry);
  }

  if (layout === 'separate') {
    // One file per source. Costs a little more space than a single mix, but
    // lets the user edit or transcribe either side on its own.
    if (wantTab) {
      const dest = ctx.createMediaStreamDestination();
      tabRecordGain.connect(dest);
      addRecorder(TRACK.TAB, dest);
      addMp3Tap(TRACK.TAB, tabRecordGain);
    }
    if (micGain) {
      const dest = ctx.createMediaStreamDestination();
      micGain.connect(dest);
      addRecorder(TRACK.MIC, dest);
      addMp3Tap(TRACK.MIC, micGain);
    }
  } else {
    // A bus so the MP3 tap hears exactly what the recorder hears. Like the
    // recorder, it never reaches ctx.destination — the mic is on it.
    const mixBus = ctx.createGain();
    tabRecordGain.connect(mixBus);
    micGain?.connect(mixBus);
    const dest = ctx.createMediaStreamDestination();
    mixBus.connect(dest);
    addRecorder(TRACK.MIX, dest);
    addMp3Tap(TRACK.MIX, mixBus);
  }

  if (!recorders.length) {
    await ctx.close().catch(() => {});
    throw new Error('ไม่มีแหล่งเสียงให้อัดเลย — เปิดอัดเสียงแท็บหรือไมโครโฟนอย่างน้อยหนึ่งอย่าง');
  }

  // Applying a stored sink choice can fail (device unplugged) — never fatal.
  if (settings.outputDeviceId) {
    await setSink(ctx, settings.outputDeviceId).catch((err) =>
      onNotice?.('sink-unavailable', String(err?.message || err))
    );
  }

  return {
    ctx,
    mimeType,
    startedAt,
    layout,
    micIncluded: !!micStream,
    tracks: recorders.map((r) => r.track),
    mp3Tracks: mp3Taps.map((t) => t.track),

    setPassthrough(on) {
      const now = ctx.currentTime;
      passthroughGain.gain.cancelScheduledValues(now);
      passthroughGain.gain.setValueAtTime(passthroughGain.gain.value, now);
      passthroughGain.gain.linearRampToValueAtTime(on ? 1 : 0, now + RAMP_SECONDS);
    },

    setOutputDevice(deviceId) {
      return setSink(ctx, deviceId);
    },

    /** RMS levels 0..1, so the UI can prove audio is actually flowing. */
    getLevels() {
      return { tab: rms(tabAnalyser), mic: micAnalyser ? rms(micAnalyser) : null };
    },

    async stop() {
      await Promise.all([
        ...recorders.map((entry) => new Promise((resolve) => {
          entry.recorder.onstop = resolve;
          if (entry.recorder.state !== 'inactive') entry.recorder.stop();
          else resolve();
        })),
        // Must finish before ctx.close(), or the last quarter-second of PCM is
        // still sitting in the worklet when the audio thread goes away.
        ...mp3Taps.map((tap) => tap.stop().catch((err) =>
          onNotice?.('chunk-write-failed', `mp3 ${tap.track}: ${String(err?.message || err)}`))),
      ]);
      await pending; // make sure the last chunk is written before we tear down

      micStream?.getTracks().forEach((t) => t.stop());
      try {
        await ctx.close();
      } catch { /* already closed */ }

      return {
        layout,
        mimeType,
        durationMs: Date.now() - startedAt,
        chunks: recorders.reduce((sum, r) => sum + r.seq, 0),
        perTrack: Object.fromEntries(recorders.map((r) => [r.track, r.seq])),
      };
    },
  };
}

/**
 * Live MP3 encoder for one track. PCM arrives from the worklet in 0.25 s
 * batches; encoded bytes are written to storage every `timeslice`, the same
 * cadence as the WebM chunks. MP3 frames concatenate cleanly, so the stored
 * chunks join back into a valid file with a correct duration.
 */
function createMp3Tap({ ctx, sourceNode, track, startedAt, timeslice, onChunk, onNotice }) {
  const encoder = new self.lamejs.Mp3Encoder(1, 16000, MP3_KBPS);
  // No outputs: Chrome pulls an output-less worklet on its own, so it never
  // needs a path to ctx.destination — which, for the mic, it must not have.
  const node = new AudioWorkletNode(ctx, 'magpie-pcm-tap', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
  });

  let parts = [];
  let seq = 0;
  let pending = Promise.resolve();
  let onFlushed = null;

  node.port.onmessage = (event) => {
    const msg = event.data;
    if (msg?.type === 'pcm') {
      const bytes = encoder.encodeBuffer(msg.samples);
      if (bytes.length) parts.push(bytes);
    } else if (msg?.type === 'flushed') {
      onFlushed?.();
    }
  };
  sourceNode.connect(node);

  function write() {
    if (!parts.length) return;
    const blob = new Blob(parts, { type: 'audio/mpeg' });
    parts = [];
    const mySeq = seq++;
    const offsetMs = Date.now() - startedAt;
    pending = pending
      .then(() => onChunk(blob, mySeq, offsetMs, track, 'mp3'))
      .catch((err) => onNotice?.('chunk-write-failed', `mp3 ${track}: ${String(err?.message || err)}`));
  }

  const timer = setInterval(write, timeslice);

  return {
    track,
    async stop() {
      clearInterval(timer);
      // Ask the worklet for its partial batch; don't hang the stop if the audio
      // thread is already gone.
      await new Promise((resolve) => {
        onFlushed = resolve;
        node.port.postMessage('stop');
        setTimeout(resolve, 1000);
      });
      try { sourceNode.disconnect(node); } catch { /* already detached */ }
      const tail = encoder.flush();
      if (tail.length) parts.push(tail);
      write();
      await pending;
    },
  };
}

async function setSink(ctx, deviceId) {
  if (typeof ctx.setSinkId !== 'function') {
    throw new Error('เบราว์เซอร์นี้เลือกลำโพงปลายทางไม่ได้');
  }
  await ctx.setSinkId(deviceId || '');
}

function rms(analyser) {
  const buf = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / buf.length) * 3); // *3 so speech is visible on a meter
}

/**
 * MediaRecorder writes its header before it knows the duration, so a file
 * assembled from timeslice chunks reports an unknown length. It plays fine, but
 * seeking in some players needs the header rewritten first. Handed to the user
 * in the export rather than hidden.
 */
export const DURATION_FIX_HINT = 'ffmpeg -i <file> -c copy <file>-fixed.webm';
