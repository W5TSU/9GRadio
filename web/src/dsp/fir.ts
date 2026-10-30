/** Hamming-windowed sinc low-pass with unity gain at DC. `taps` should be odd. */
export function lowpassTaps(taps: number, cutoffHz: number, rateHz: number): Float32Array {
  const h = new Float64Array(taps);
  const fc = cutoffHz / rateHz;
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    h[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1)));
    sum += h[i];
  }
  return Float32Array.from(h, (v) => v / sum);
}

/** Decimating FIR over interleaved complex samples. The output array is reused. */
export class ComplexFir {
  private readonly i: Float32Array;
  private readonly q: Float32Array;
  private at = 0;
  private count = 0;
  private out = new Float32Array(0);

  constructor(
    private readonly taps: Float32Array,
    private readonly decimation = 1,
  ) {
    this.i = new Float32Array(taps.length * 2);
    this.q = new Float32Array(taps.length * 2);
  }

  process(iq: Float32Array): Float32Array {
    const { taps, i: hi, q: hq, decimation } = this;
    const n = taps.length;
    const inCount = iq.length >> 1;
    const maxOut = Math.ceil((inCount + this.count) / decimation) * 2;
    if (this.out.length < maxOut) this.out = new Float32Array(maxOut);
    const out = this.out;
    let o = 0;
    let at = this.at;
    let count = this.count;
    for (let s = 0; s < inCount; s++) {
      // Each sample is written twice so the last n samples are always contiguous.
      const a = iq[2 * s];
      const b = iq[2 * s + 1];
      hi[at] = a;
      hi[at + n] = a;
      hq[at] = b;
      hq[at + n] = b;
      at = at + 1 === n ? 0 : at + 1;
      if (++count === decimation) {
        count = 0;
        let re = 0;
        let im = 0;
        for (let k = 0, p = at; k < n; k++, p++) {
          re += taps[k] * hi[p];
          im += taps[k] * hq[p];
        }
        out[o++] = re;
        out[o++] = im;
      }
    }
    this.at = at;
    this.count = count;
    return out.subarray(0, o);
  }
}

/** Decimating FIR over real samples. The output array is reused. */
export class RealFir {
  private readonly hist: Float32Array;
  private at = 0;
  private count = 0;
  private out = new Float32Array(0);

  constructor(
    private readonly taps: Float32Array,
    private readonly decimation = 1,
  ) {
    this.hist = new Float32Array(taps.length * 2);
  }

  process(x: Float32Array): Float32Array {
    const { taps, hist, decimation } = this;
    const n = taps.length;
    const maxOut = Math.ceil((x.length + this.count) / decimation);
    if (this.out.length < maxOut) this.out = new Float32Array(maxOut);
    const out = this.out;
    let o = 0;
    let at = this.at;
    let count = this.count;
    for (let s = 0; s < x.length; s++) {
      hist[at] = x[s];
      hist[at + n] = x[s];
      at = at + 1 === n ? 0 : at + 1;
      if (++count === decimation) {
        count = 0;
        let y = 0;
        for (let k = 0, p = at; k < n; k++, p++) y += taps[k] * hist[p];
        out[o++] = y;
      }
    }
    this.at = at;
    this.count = count;
    return out.subarray(0, o);
  }
}

/** Multiplies interleaved complex samples by a rotating phasor, in place. */
export class Nco {
  private re = 1;
  private im = 0;
  private readonly stepRe: number;
  private readonly stepIm: number;
  private count = 0;

  constructor(freqHz: number, rateHz: number) {
    const w = (2 * Math.PI * freqHz) / rateHz;
    this.stepRe = Math.cos(w);
    this.stepIm = Math.sin(w);
  }

  mix(iq: Float32Array) {
    let { re, im } = this;
    const { stepRe, stepIm } = this;
    for (let s = 0; s < iq.length; s += 2) {
      const a = iq[s];
      const b = iq[s + 1];
      iq[s] = a * re - b * im;
      iq[s + 1] = a * im + b * re;
      const r = re * stepRe - im * stepIm;
      im = re * stepIm + im * stepRe;
      re = r;
    }
    this.count += iq.length;
    if (this.count > 1 << 20) {
      this.count = 0;
      const mag = Math.hypot(re, im);
      re /= mag;
      im /= mag;
    }
    this.re = re;
    this.im = im;
  }
}
