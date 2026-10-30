/** Averaged power spectrum of complex IQ, in dBFS, with DC in the middle bin. */
export class PowerSpectrum {
  private readonly window: Float64Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly power: Float64Array;
  private readonly out: Float32Array;
  private readonly norm: number;

  constructor(readonly size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error(`FFT size ${size} is not a power of 2`);
    const n = size;
    this.window = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
      sum += this.window[i];
    }
    this.norm = 1 / (sum * sum);
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.power = new Float64Array(n);
    this.out = new Float32Array(n);
  }

  /**
   * Reads `blocks` consecutive blocks from interleaved IQ. The returned array
   * is reused by the next call.
   */
  compute(iq: Float32Array, blocks = 1): Float32Array {
    const n = this.size;
    if (iq.length < 2 * n * blocks) throw new Error('Not enough samples for the requested blocks');
    this.power.fill(0);
    for (let b = 0; b < blocks; b++) {
      this.transform(iq, b * n * 2);
      for (let i = 0; i < n; i++) this.power[i] += this.re[i] * this.re[i] + this.im[i] * this.im[i];
    }
    const scale = this.norm / blocks;
    const half = n >> 1;
    for (let i = 0; i < n; i++) {
      const p = this.power[(i + half) & (n - 1)] * scale;
      this.out[i] = 10 * Math.log10(p + 1e-20);
    }
    return this.out;
  }

  private transform(iq: Float32Array, offset: number) {
    const { re, im, rev, window, cos, sin, size: n } = this;
    for (let i = 0; i < n; i++) {
      const r = rev[i];
      re[r] = iq[offset + 2 * i] * window[i];
      im[r] = iq[offset + 2 * i + 1] * window[i];
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let start = 0; start < n; start += len) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = start + j;
          const b = a + half;
          const tr = re[b] * cos[k] - im[b] * sin[k];
          const ti = re[b] * sin[k] + im[b] * cos[k];
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }
}
