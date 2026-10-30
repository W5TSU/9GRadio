import { parseFrame, type Ax25Frame } from './ax25';

const MARK_HZ = 1200;
const SPACE_HZ = 2200;
const BAUD = 1200;
const LONG_WINDOW_BITS = 1.5;
const MIN_FRAME_BITS = 144;
const MAX_FRAME_BITS = 4096;
/** How far a tone transition pulls the bit clock toward mid-bit. From Dire Wolf. */
const DPLL_NUDGE = 0.3;
const AGC_ATTACK = 0.7;
const AGC_DECAY = 9e-5;
const AGC_INITIAL_PEAK = 1e-3;

/** One tone detector: sliding correlation over a short and a long window, self-normalised. */
class ToneCorrelator {
  private readonly cosStep: number;
  private readonly sinStep: number;
  private pRe = 1;
  private pIm = 0;
  private count = 0;
  private readonly short: Window;
  private readonly long: Window;

  constructor(toneHz: number, rate: number) {
    this.cosStep = Math.cos((2 * Math.PI * toneHz) / rate);
    this.sinStep = Math.sin((2 * Math.PI * toneHz) / rate);
    this.short = new Window(Math.max(4, Math.round(rate / BAUD)));
    this.long = new Window(Math.max(6, Math.round((rate / BAUD) * LONG_WINDOW_BITS)));
  }

  process(x: number): number {
    const ci = x * this.pRe;
    const cq = x * this.pIm;
    const re = this.pRe * this.cosStep - this.pIm * this.sinStep;
    this.pIm = this.pRe * this.sinStep + this.pIm * this.cosStep;
    this.pRe = re;
    if ((++this.count & 0xfff) === 0) {
      const mag = Math.hypot(this.pRe, this.pIm);
      this.pRe /= mag;
      this.pIm /= mag;
    }
    return (this.short.process(ci, cq) + this.long.process(ci, cq)) * 0.5;
  }
}

class Window {
  private readonly i: Float64Array;
  private readonly q: Float64Array;
  private at = 0;
  private sumI = 0;
  private sumQ = 0;
  private peak = AGC_INITIAL_PEAK;
  private valley = 0;

  constructor(private readonly n: number) {
    this.i = new Float64Array(n);
    this.q = new Float64Array(n);
  }

  /** Returns the tone's power, normalised to -0.5..0.5 of its own recent range. */
  process(ci: number, cq: number): number {
    this.sumI += ci - this.i[this.at];
    this.sumQ += cq - this.q[this.at];
    this.i[this.at] = ci;
    this.q[this.at] = cq;
    this.at = this.at + 1 >= this.n ? 0 : this.at + 1;

    const p = this.sumI * this.sumI + this.sumQ * this.sumQ;
    this.peak += (p - this.peak) * (p >= this.peak ? AGC_ATTACK : AGC_DECAY);
    this.valley += (p - this.valley) * (p <= this.valley ? AGC_ATTACK : AGC_DECAY);
    if (this.peak <= this.valley) return 0;
    const clipped = Math.min(this.peak, Math.max(this.valley, p));
    return (clipped - 0.5 * (this.peak + this.valley)) / (this.peak - this.valley);
  }
}

/** Bell 202 audio in, checked AX.25 frames out. */
export class AfskDecoder {
  private readonly mark: ToneCorrelator;
  private readonly space: ToneCorrelator;
  private readonly phaseStep: number;
  private phase = 0;
  private lastRaw = false;
  private lastBit = false;
  private pattern = 0;
  private readonly bits = new Uint8Array(MAX_FRAME_BITS);
  private bitCount = 0;
  private out: Ax25Frame[] = [];

  constructor(rate: number) {
    this.mark = new ToneCorrelator(MARK_HZ, rate);
    this.space = new ToneCorrelator(SPACE_HZ, rate);
    this.phaseStep = BAUD / rate;
  }

  push(audio: Float32Array): Ax25Frame[] {
    this.out = [];
    for (let i = 0; i < audio.length; i++) {
      const x = audio[i];
      const raw = this.mark.process(x) > this.space.process(x);
      if (raw !== this.lastRaw) {
        this.phase += DPLL_NUDGE * (0.5 - this.phase);
        this.lastRaw = raw;
      }
      this.phase += this.phaseStep;
      if (this.phase >= 1) {
        this.phase -= 1;
        this.pushLevel(raw);
      }
    }
    return this.out;
  }

  /** NRZI: no tone change is a 1. */
  private pushLevel(level: boolean) {
    const bit = level === this.lastBit ? 1 : 0;
    this.lastBit = level;

    this.pattern = ((this.pattern >> 1) | (bit << 7)) & 0xff;
    if (this.bitCount < MAX_FRAME_BITS) this.bits[this.bitCount++] = bit;
    else this.bitCount = 0;

    if (this.pattern === 0x7e) {
      const dataBits = this.bitCount - 8;
      if (dataBits >= MIN_FRAME_BITS) this.finishFrame(dataBits);
      this.bitCount = 0;
    }
  }

  private finishFrame(dataBits: number) {
    const bytes = new Uint8Array(Math.ceil(dataBits / 8));
    let ones = 0;
    let out = 0;
    for (let i = 0; i < dataBits; i++) {
      if (this.bits[i]) {
        ones++;
        bytes[out >> 3] |= 1 << (out & 7);
        out++;
      } else {
        // A 0 straight after five 1s was stuffed by the sender.
        if (ones !== 5) out++;
        ones = 0;
      }
    }
    if (out % 8 !== 0) return;
    const frame = parseFrame(bytes.subarray(0, out / 8));
    if (frame) this.out.push(frame);
  }
}
