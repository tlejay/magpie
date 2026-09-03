// The "virtual speaker": tab audio keeps playing out of the real speakers while
// a copy of it — mixed with the microphone — is recorded to disk.
//
// Two rules govern this whole file, and breaking either one ruins a meeting:
//
//   1. Capturing tab audio MUTES the tab. Chrome hands you the stream and stops
//      playing it. Passthrough is not a feature, it is a repair — without it the
//      user sits through a silent meeting.
//   2. The microphone must NEVER reach ctx.destination. Tab audio -> speakers is
//      fine; mic -> speakers is a feedback loop into the user's own ears.
//
//        tab ──┬─(passthroughGain)─→ ctx.destination ──→ real speakers
//              └─────────────────┐
//        mic ────(micGain)───────┴─→ mixDestination ──→ MediaRecorder

const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
];

const RAMP_SECONDS = 0.015; // short fade so toggling passthrough doesn't click

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
 * @param {Function} opts.onChunk        (blob, seq, offsetMs) => Promise — persist immediately
 * @param {Function} opts.onNotice       (code, detail) => void — non-fatal problems worth telling the user
 */
export async function createAudioPipeline({ tabStream, settings, onChunk, onNotice }) {
  const tabTrack = tabStream.getAudioTracks()[0];
  if (!tabTrack) throw new Error('ไม่มี audio track ในสตรีมของแท็บ');

  const ctx = new AudioContext();
  if (ctx.state === 'suspended') await ctx.resume();

  const tabSource = ctx.createMediaStreamSource(new MediaStream([tabTrack]));
  const mixDestination = ctx.createMediaStreamDestination();

  // --- passthrough: the repair for Chrome muting the captured tab
  const passthroughGain = ctx.createGain();
  passthroughGain.gain.value = settings.passthrough === false ? 0 : 1;
  tabSource.connect(passthroughGain);
  passthroughGain.connect(ctx.destination);

  // --- the recorded mix
  const tabRecordGain = ctx.createGain();
  tabRecordGain.gain.value = settings.recordTabAudio === false ? 0 : 1;
  tabSource.connect(tabRecordGain);
  tabRecordGain.connect(mixDestination);

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
      micSource.connect(micGain);
      micGain.connect(mixDestination); // deliberately NOT ctx.destination

      micAnalyser = ctx.createAnalyser();
      micAnalyser.fftSize = 512;
      micSource.connect(micAnalyser);
    } catch (err) {
      // Recording without the mic is still useful — but say so out loud rather
      // than handing back a file that is quietly missing half the conversation.
      onNotice?.('mic-unavailable', String(err?.name || err));
    }
  }

  // --- recorder
  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(mixDestination.stream, {
    ...(mimeType ? { mimeType } : {}),
    audioBitsPerSecond: (settings.audioBitrateKbps || 64) * 1000,
  });

  const startedAt = Date.now();
  let seq = 0;
  let pending = Promise.resolve();

  recorder.ondataavailable = (event) => {
    if (!event.data || !event.data.size) return;
    const mySeq = seq++;
    const offsetMs = Date.now() - startedAt;
    // Chain the writes so chunks reach storage in order even if IndexedDB is slow.
    pending = pending
      .then(() => onChunk(event.data, mySeq, offsetMs))
      .catch((err) => onNotice?.('chunk-write-failed', String(err?.message || err)));
  };
  recorder.onerror = (event) => onNotice?.('recorder-error', String(event?.error?.name || 'unknown'));

  recorder.start(Math.max(1000, (settings.chunkSeconds || 5) * 1000));

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
    micIncluded: !!micStream,

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
      const finished = new Promise((resolve) => {
        recorder.onstop = resolve;
      });
      if (recorder.state !== 'inactive') recorder.stop();
      await finished;
      await pending; // make sure the last chunk is written before we tear down

      micStream?.getTracks().forEach((t) => t.stop());
      try {
        await ctx.close();
      } catch { /* already closed */ }

      return { chunks: seq, durationMs: Date.now() - startedAt, mimeType };
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
export const DURATION_FIX_HINT =
  'ffmpeg -i audio.webm -c copy audio-fixed.webm';
