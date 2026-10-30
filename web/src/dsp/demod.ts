import { ComplexFir, Nco, RealFir, lowpassTaps } from './fir';

export type Mode = 'AM' | 'NFM' | 'WFM' | 'USB' | 'LSB' | 'CW' | 'APRS';

export const AUDIO_RATE = 48_000;
const IF_RATE = 240_000;
const NFM_DEVIATION_HZ = 5_000;
const WFM_DEVIATION_HZ = 75_000;
const CW_NOTE_HZ = 700;
const SSB_MID_HZ = 1_650;
const SSB_HALF_WIDTH_HZ = 1_350;

/** Channel widths, used for filtering and for deciding two hits are one signal. */
export const CHANNEL_WIDTH_HZ: Record<Mode, number> = {
  AM: 10_000,
  NFM: 12_500,
  WFM: 200_000,
  USB: 3_000,
  LSB: 3_000,
  CW: 500,
  APRS: 12_500,
};

const CHANNEL_FILTER: Record<Exclude<Mode, 'WFM'>, { cutoffHz: number; taps: number }> = {
  AM: { cutoffHz: 5_000, taps: 129 },
  NFM: { cutoffHz: 7_000, taps: 129 },
  APRS: { cutoffHz: 7_000, taps: 129 },
  USB: { cutoffHz: SSB_HALF_WIDTH_HZ, taps: 193 },
  LSB: { cutoffHz: SSB_HALF_WIDTH_HZ, taps: 193 },
  CW: { cutoffHz: 250, taps: 385 },
};

/** Keeps audio near a target level, with a limit on how much it can amplify. */
class Agc {
  private env = 0.01;
  private readonly attack = 1 - Math.exp(-1 / (0.005 * AUDIO_RATE));
  private readonly release = 1 - Math.exp(-1 / (0.5 * AUDIO_RATE));

  process(x: Float32Array) {
    let env = this.env;
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i]);
      env += (a - env) * (a > env ? this.attack : this.release);
      const gain = Math.min(0.3 / Math.max(env, 1e-6), 1000);
      x[i] = Math.max(-1, Math.min(1, x[i] * gain));
    }
    this.env = env;
  }
}

/** Quadrature FM discriminator over interleaved IQ. */
class Discriminator {
  private lastI = 0;
  private lastQ = 0;

  constructor(private readonly scale: number) {}

  process(iq: Float32Array, out: Float32Array) {
    let { lastI, lastQ } = this;
    for (let s = 0, o = 0; s < iq.length; s += 2, o++) {
      const i = iq[s];
      const q = iq[s + 1];
      out[o] = Math.atan2(q * lastI - i * lastQ, i * lastI + q * lastQ) * this.scale;
      lastI = i;
      lastQ = q;
    }
    this.lastI = lastI;
    this.lastQ = lastQ;
  }
}

/** One-pole filters shared by the audio paths. */
class OnePole {
  private y = 0;
  private readonly a: number;

  constructor(cornerHz: number, rate: number) {
    this.a = 1 - Math.exp((-2 * Math.PI * cornerHz) / rate);
  }

  lowpass(x: Float32Array, makeup = 1) {
    let y = this.y;
    for (let i = 0; i < x.length; i++) {
      y += (x[i] - y) * this.a;
      x[i] = Math.max(-1, Math.min(1, y * makeup));
    }
    this.y = y;
  }

  highpass(x: Float32Array) {
    let y = this.y;
    for (let i = 0; i < x.length; i++) {
      y += (x[i] - y) * this.a;
      x[i] -= y;
    }
    this.y = y;
  }
}

export interface DemodOptions {
  /** Turn off the level control, to measure filters on their own. */
  agc?: boolean;
}

/**
 * Takes wideband IQ, picks one channel at `offsetHz` from the tuned center, and
 * produces 48 kHz audio. `flatFm` holds the unfiltered FM output for data decoders.
 */
export class ChannelDemod {
  flatFm: Float32Array = new Float32Array(0);

  private readonly nco: Nco;
  private readonly toIf: ComplexFir;
  private readonly toAudioRate: ComplexFir | null;
  private readonly channel: ComplexFir | null;
  private readonly preShift: Nco | null;
  private readonly postShift: Nco | null;
  private readonly wfmAudio: RealFir | null;
  private readonly agc: Agc | null;
  private readonly discriminator: Discriminator | null;
  private readonly lowCut: OnePole | null;
  private readonly deemphasis: OnePole | null;
  private readonly dcBlock: OnePole | null;
  private readonly makeup: number;
  private work = new Float32Array(0);
  private fmBuf = new Float32Array(0);

  constructor(
    private readonly mode: Mode,
    inputRate: number,
    offsetHz: number,
    options: DemodOptions = {},
  ) {
    const d1 = inputRate / IF_RATE;
    if (!Number.isInteger(d1)) throw new Error(`Sample rate ${inputRate} is not a multiple of 240 kHz`);

    this.nco = new Nco(-offsetHz, inputRate);
    this.toIf = new ComplexFir(lowpassTaps(12 * d1 + 1, 120_000, inputRate), d1);

    const isFm = mode === 'NFM' || mode === 'APRS' || mode === 'WFM';
    const isAgc = (mode === 'AM' || mode === 'USB' || mode === 'LSB' || mode === 'CW') && options.agc !== false;
    this.agc = isAgc ? new Agc() : null;
    this.dcBlock = mode === 'AM' ? new OnePole(30, AUDIO_RATE) : null;

    if (mode === 'WFM') {
      this.toAudioRate = null;
      this.channel = null;
      this.wfmAudio = new RealFir(lowpassTaps(61, 15_000, IF_RATE), IF_RATE / AUDIO_RATE);
      this.discriminator = new Discriminator(IF_RATE / (2 * Math.PI * WFM_DEVIATION_HZ));
      this.deemphasis = new OnePole(2122, AUDIO_RATE); // 75 microseconds
      this.lowCut = null;
      this.makeup = 1;
    } else {
      this.wfmAudio = null;
      this.toAudioRate = new ComplexFir(lowpassTaps(31, 20_000, IF_RATE), IF_RATE / AUDIO_RATE);
      const { cutoffHz, taps } = CHANNEL_FILTER[mode];
      this.channel = new ComplexFir(lowpassTaps(taps, cutoffHz, AUDIO_RATE));
      this.discriminator = isFm ? new Discriminator(AUDIO_RATE / (2 * Math.PI * NFM_DEVIATION_HZ)) : null;
      // Voice FM: drop sub-audible tones, then undo the transmitter's pre-emphasis.
      this.lowCut = isFm ? new OnePole(250, AUDIO_RATE) : null;
      this.deemphasis = isFm ? new OnePole(1000, AUDIO_RATE) : null;
      this.makeup = isFm ? 1.5 : 1;
    }

    const shift = mode === 'USB' ? SSB_MID_HZ : mode === 'LSB' ? -SSB_MID_HZ : 0;
    this.preShift = shift ? new Nco(-shift, AUDIO_RATE) : null;
    this.postShift = shift ? new Nco(shift, AUDIO_RATE) : mode === 'CW' ? new Nco(CW_NOTE_HZ, AUDIO_RATE) : null;
  }

  /** The returned audio array is reused by the next call. */
  process(iq: Float32Array): Float32Array {
    if (this.work.length < iq.length) this.work = new Float32Array(iq.length);
    const copy = this.work.subarray(0, iq.length);
    copy.set(iq);
    this.nco.mix(copy);
    const atIf = this.toIf.process(copy);
    return this.mode === 'WFM' ? this.processWfm(atIf) : this.processNarrow(atIf);
  }

  private processWfm(atIf: Float32Array): Float32Array {
    const fm = this.fmBuffer(atIf.length >> 1);
    this.discriminator!.process(atIf, fm);
    const audio = this.wfmAudio!.process(fm);
    this.deemphasis!.lowpass(audio);
    return audio;
  }

  private processNarrow(atIf: Float32Array): Float32Array {
    const atAudio = this.toAudioRate!.process(atIf);
    this.preShift?.mix(atAudio);
    const channel = this.channel!.process(atAudio);
    const n = channel.length >> 1;

    if (this.discriminator) {
      const fm = this.fmBuffer(n);
      this.discriminator.process(channel, fm);
      this.flatFm = fm;
      const audio = Float32Array.from(fm);
      this.lowCut!.highpass(audio);
      this.deemphasis!.lowpass(audio, this.makeup);
      return audio;
    }

    const audio = new Float32Array(n);
    if (this.mode === 'AM') {
      for (let i = 0; i < n; i++) audio[i] = Math.hypot(channel[2 * i], channel[2 * i + 1]);
      this.dcBlock!.highpass(audio);
    } else {
      this.postShift!.mix(channel);
      for (let i = 0; i < n; i++) audio[i] = channel[2 * i];
    }
    this.agc?.process(audio);
    return audio;
  }

  private fmBuffer(n: number) {
    if (this.fmBuf.length < n) this.fmBuf = new Float32Array(n);
    return this.fmBuf.subarray(0, n);
  }
}
