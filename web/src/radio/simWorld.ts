import { afskAudio, buildUiFrame, type UiFrameFields } from './aprsTx';

/** Signal shapes a simulated transmitter can produce. */
export type SimMode = 'CARRIER' | 'AM' | 'NFM' | 'WFM' | 'USB' | 'LSB' | 'CW' | 'APRS';

export interface SimEmitter {
  label?: string;
  freqHz: number;
  mode: SimMode;
  /** Level as read on the spectrum, in dBFS. */
  levelDb: number;
  /** On-air test for everything but APRS. */
  on?: (tSec: number) => boolean;
  /** APRS: seconds between packets, and the packets to cycle through. */
  periodS?: number;
  startS?: number;
  packets?: UiFrameFields[];
}

const VOICE_STEP = 48;
const AFSK_RATE = 48_000;
const NFM_DEV_HZ = 3_000;
const APRS_DEV_HZ = 3_000;
const WFM_DEV_HZ = 60_000;
const NOISE_TABLE_SIZE = 1 << 18;

const SYLLABLES_PER_S = 2.7;
const PITCHES_HZ = [180, 210, 165, 230, 195, 150, 205];
const PAUSE_EVERY = 5;

function syllableOf(t: number) {
  return Math.floor(t * SYLLABLES_PER_S);
}

/** 0 to 1 within a syllable, silent at its edges and for every few syllables. */
function syllableEnvelope(t: number) {
  const n = syllableOf(t);
  if (n % PAUSE_EVERY === PAUSE_EVERY - 1) return 0;
  return Math.sin(Math.PI * (t * SYLLABLES_PER_S - n));
}

/** Phase of one cycle of the syllable's pitch. Measured from the syllable's start to stay bounded. */
function pitchPhase(t: number) {
  const n = syllableOf(t);
  return 2 * Math.PI * PITCHES_HZ[n % PITCHES_HZ.length] * (t - n / SYLLABLES_PER_S);
}

/** Syllable-paced tones: recognisable as speech rhythm without needing audio files. */
export function voice(t: number) {
  const w = pitchPhase(t);
  return syllableEnvelope(t) * (0.5 * Math.sin(w) + 0.3 * Math.sin(2.5 * w) + 0.2 * Math.sin(6 * w));
}

/** Morse-like keying: a repeating pattern of dits, dahs and gaps. */
const CW_KEYING = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 1, 0, 1, 0, 1, 1, 1, 0, 0, 0];
function cwKeyed(t: number) {
  return CW_KEYING[Math.floor(t * 12) % CW_KEYING.length] === 1;
}

function makeNoiseTable(seed: number) {
  let s = seed >>> 0;
  const uniform = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
  const table = new Float32Array(NOISE_TABLE_SIZE);
  for (let i = 0; i < table.length; i += 2) {
    const r = Math.sqrt(-2 * Math.log(uniform() + 1e-12));
    const a = 2 * Math.PI * uniform();
    table[i] = r * Math.cos(a);
    table[i + 1] = r * Math.sin(a);
  }
  return table;
}

interface EmitterState {
  emitter: SimEmitter;
  amplitude: number;
  fmPhase: number;
  bursts: Float32Array[];
}

/** A band of simulated transmitters, rendered as the IQ a radio would deliver. */
export class SimWorld {
  private readonly states: EmitterState[];
  private readonly noise: Float32Array;
  private noiseAt = 0;

  constructor(
    emitters: SimEmitter[],
    private readonly noiseRms = 0.004,
    seed = 1,
  ) {
    this.noise = makeNoiseTable(seed);
    this.states = emitters.map((emitter) => ({
      emitter,
      amplitude: 10 ** (emitter.levelDb / 20),
      fmPhase: 0,
      bursts: (emitter.packets ?? []).map((p) => afskAudio(buildUiFrame(p), AFSK_RATE, { amplitude: 1 })),
    }));
  }

  /** Fills `out` with interleaved IQ for the block starting at `tSec`. */
  render(centerHz: number, fs: number, tSec: number, out: Float32Array) {
    const noise = this.noise;
    let at = this.noiseAt;
    const sigma = this.noiseRms;
    for (let i = 0; i < out.length; i++) {
      out[i] = noise[at] * sigma;
      at = at + 1 === NOISE_TABLE_SIZE ? 0 : at + 1;
    }
    // Hop around the table so successive blocks don't line up.
    this.noiseAt = (at + 7919) % NOISE_TABLE_SIZE;

    for (const s of this.states) {
      const offset = s.emitter.freqHz - centerHz;
      if (Math.abs(offset) < fs / 2) this.renderEmitter(s, offset, fs, tSec, out);
    }
  }

  private renderEmitter(s: EmitterState, offsetHz: number, fs: number, tSec: number, out: Float32Array) {
    const { emitter: e, amplitude: a } = s;
    const n = out.length >> 1;

    let burst: Float32Array | null = null;
    let burstStart = 0;
    if (e.mode === 'APRS') {
      if (!s.bursts.length) return;
      const period = e.periodS ?? 10;
      const since = tSec - (e.startS ?? 0);
      const index = Math.floor(since / period);
      burstStart = (e.startS ?? 0) + index * period;
      burst = s.bursts[((index % s.bursts.length) + s.bursts.length) % s.bursts.length];
      if (tSec - burstStart > burst.length / AFSK_RATE) return;
    } else if (e.on && !e.on(tSec) && !e.on(tSec + n / fs)) {
      return;
    }

    const fmDev = e.mode === 'WFM' ? WFM_DEV_HZ : e.mode === 'APRS' ? APRS_DEV_HZ : NFM_DEV_HZ;
    const isFm = e.mode === 'NFM' || e.mode === 'WFM' || e.mode === 'APRS';
    let phase = isFm ? s.fmPhase : 2 * Math.PI * ((offsetHz * tSec) % 1);

    for (let i = 0; i < n; i += VOICE_STEP) {
      const t = tSec + i / fs;
      if (e.on && !e.on(t)) {
        phase += (2 * Math.PI * offsetHz * Math.min(VOICE_STEP, n - i)) / fs;
        continue;
      }

      let fHz = offsetHz;
      let ampI = a;
      let ampQ = 0;
      switch (e.mode) {
        case 'NFM':
        case 'WFM':
          fHz += fmDev * voice(t);
          break;
        case 'APRS': {
          const k = Math.floor((t - burstStart) * AFSK_RATE);
          if (k < 0 || k >= burst!.length) {
            s.fmPhase = phase;
            return;
          }
          fHz += fmDev * burst![k];
          break;
        }
        case 'AM':
          ampI = a * (1 + 0.8 * voice(t));
          break;
        case 'USB':
        case 'LSB': {
          // Analytic voice-band signal: only one side of the carrier.
          const env = syllableEnvelope(t);
          const w = pitchPhase(t);
          const sign = e.mode === 'USB' ? 1 : -1;
          ampI = a * env * (0.5 * Math.cos(2 * w) + 0.3 * Math.cos(5 * w) + 0.2 * Math.cos(11 * w));
          ampQ = sign * a * env * (0.5 * Math.sin(2 * w) + 0.3 * Math.sin(5 * w) + 0.2 * Math.sin(11 * w));
          break;
        }
        case 'CW':
          if (!cwKeyed(t)) {
            phase += (2 * Math.PI * offsetHz * Math.min(VOICE_STEP, n - i)) / fs;
            continue;
          }
          break;
      }

      const end = Math.min(n, i + VOICE_STEP);
      const step = (2 * Math.PI * fHz) / fs;
      const stepRe = Math.cos(step);
      const stepIm = Math.sin(step);
      let re = Math.cos(phase);
      let im = Math.sin(phase);
      for (let k = i; k < end; k++) {
        out[2 * k] += ampI * re - ampQ * im;
        out[2 * k + 1] += ampI * im + ampQ * re;
        const r = re * stepRe - im * stepIm;
        im = re * stepIm + im * stepRe;
        re = r;
      }
      phase += step * (end - i);
    }
    if (isFm) s.fmPhase = phase % (2 * Math.PI);
  }
}
