// Runs on the audio thread. Taps whatever feeds a recorder, folds it to mono,
// brings it down to 16 kHz and hands it to the page in small batches for MP3
// encoding.
//
// 16 kHz mono is what speech-to-text models work at anyway — anything more is
// bytes an LLM upload limit has to pay for and the transcript never uses.

const OUT_RATE = 16000;
const BATCH = 4000; // 0.25 s at 16 kHz — few enough messages, small enough to lose nothing on stop

class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / OUT_RATE; // input samples per output sample
    this.acc = 0;     // running sum for the current output sample (box filter = cheap anti-alias)
    this.count = 0;
    this.pos = 0;     // fractional position inside the current output window
    this.buf = new Int16Array(BATCH);
    this.len = 0;
    this.stopped = false;

    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        this.post();
        this.port.postMessage({ type: 'flushed' });
      } else if (e.data === 'stop') {
        this.post();
        this.stopped = true;
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }

  post() {
    if (!this.len) return;
    const out = this.buf.slice(0, this.len);
    this.port.postMessage({ type: 'pcm', samples: out }, [out.buffer]);
    this.len = 0;
  }

  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0];
    // No connected input this quantum — the graph is idle, not silent. Keep the
    // node alive but don't invent samples.
    if (!input || !input.length) return true;

    const frames = input[0].length;
    const channels = input.length;
    for (let i = 0; i < frames; i++) {
      let v = 0;
      for (let c = 0; c < channels; c++) v += input[c][i];
      this.acc += v / channels;
      this.count += 1;
      this.pos += 1;
      if (this.pos >= this.step) {
        this.pos -= this.step;
        const s = Math.max(-1, Math.min(1, this.acc / this.count));
        this.buf[this.len++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        this.acc = 0;
        this.count = 0;
        if (this.len === BATCH) this.post();
      }
    }
    return true;
  }
}

registerProcessor('magpie-pcm-tap', PcmTap);
