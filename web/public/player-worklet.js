// Plays blocks of 48 kHz audio sent from the page, through a small ring buffer.
const CAPACITY = 48000;
const START_LEVEL = 4800; // Build up 100 ms before playing, to ride out jitter.
const MAX_LEVEL = 24000; // Past 500 ms behind, drop the oldest audio to catch up.

class Player extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(CAPACITY);
    this.read = 0;
    this.write = 0;
    this.level = 0;
    this.playing = false;
    this.port.onmessage = ({ data }) => {
      if (data === 'flush') {
        this.read = this.write = this.level = 0;
        this.playing = false;
        return;
      }
      for (let i = 0; i < data.length; i++) {
        this.ring[this.write] = data[i];
        this.write = (this.write + 1) % CAPACITY;
      }
      this.level += data.length;
      if (this.level > MAX_LEVEL) {
        const drop = this.level - MAX_LEVEL;
        this.read = (this.read + drop) % CAPACITY;
        this.level = MAX_LEVEL;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!this.playing && this.level >= START_LEVEL) this.playing = true;
    for (let i = 0; i < out.length; i++) {
      if (this.playing && this.level > 0) {
        out[i] = this.ring[this.read];
        this.read = (this.read + 1) % CAPACITY;
        this.level--;
      } else {
        out[i] = 0;
        this.playing = false;
      }
    }
    return true;
  }
}

registerProcessor('player', Player);
