import { AUDIO_RATE } from '../dsp/demod';

/** Plays the audio of whichever radio is the current player. */
export class AudioOut {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private volume = 0.8;
  private muted = false;
  /** Level of the most recent block, for the meter. */
  level = 0;

  /** Must first be called from a click: browsers only allow sound after one. */
  async resume() {
    if (!this.ctx) {
      const ctx = new AudioContext({ sampleRate: AUDIO_RATE, latencyHint: 'interactive' });
      await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}player-worklet.js`);
      const node = new AudioWorkletNode(ctx, 'player', { outputChannelCount: [1] });
      const gain = ctx.createGain();
      node.connect(gain).connect(ctx.destination);
      this.ctx = ctx;
      this.node = node;
      this.gain = gain;
      this.applyVolume();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  push(samples: Float32Array) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    this.level = samples.length ? Math.sqrt(sum / samples.length) : 0;
    this.node?.port.postMessage(samples, [samples.buffer as ArrayBuffer]);
  }

  /** Throws away what is buffered, so a switched signal starts right away. */
  flush() {
    this.level = 0;
    this.node?.port.postMessage('flush');
  }

  setVolume(volume: number) {
    this.volume = volume;
    this.applyVolume();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.applyVolume();
  }

  get isMuted() {
    return this.muted;
  }

  private applyVolume() {
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
  }
}
