import { describe, expect, it } from 'vitest';
import { ChannelDemod } from '../src/dsp/demod';
import { AfskDecoder } from '../src/decoders/afsk';
import { afskAudio, buildUiFrame } from '../src/radio/aprsTx';

const FS = 2_400_000;
const OFFSET = 300_000;

type Sig = (t: number) => [number, number];

/** Complex baseband at `offsetHz` from the tuned center. */
function render(sig: Sig, seconds: number, fs = FS, offsetHz = OFFSET) {
  const n = Math.floor(seconds * fs);
  const iq = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const [a, b] = sig(t);
    const w = 2 * Math.PI * offsetHz * t;
    iq[2 * i] = a * Math.cos(w) - b * Math.sin(w);
    iq[2 * i + 1] = a * Math.sin(w) + b * Math.cos(w);
  }
  return iq;
}

function fmTone(toneHz: number, devHz: number, amp = 0.5): Sig {
  const k = devHz / toneHz;
  return (t) => {
    const ph = k * Math.sin(2 * Math.PI * toneHz * t);
    return [amp * Math.cos(ph), amp * Math.sin(ph)];
  };
}

/** Fraction of the audio's power that sits at `hz`. */
function toneFraction(audio: Float32Array, hz: number, rate = 48_000) {
  // Skip the filters' start-up.
  const a = audio.subarray(Math.min(4800, audio.length >> 2));
  let re = 0;
  let im = 0;
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    const w = (2 * Math.PI * hz * i) / rate;
    re += a[i] * Math.cos(w);
    im += a[i] * Math.sin(w);
    total += a[i] * a[i];
  }
  return total === 0 ? 0 : (2 * (re * re + im * im)) / (a.length * total);
}

function rms(audio: Float32Array) {
  const a = audio.subarray(audio.length >> 2);
  return Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
}

function demodAll(mode: Parameters<typeof makeDemod>[0], iq: Float32Array, fs = FS, block = 19_200) {
  const d = makeDemod(mode, fs);
  const parts: Float32Array[] = [];
  for (let i = 0; i < iq.length; i += block) parts.push(Float32Array.from(d.process(iq.subarray(i, i + block))));
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function makeDemod(mode: 'AM' | 'NFM' | 'WFM' | 'USB' | 'LSB' | 'CW' | 'APRS', fs: number) {
  return new ChannelDemod(mode, fs, OFFSET);
}

describe('ChannelDemod', () => {
  it('outputs 48 kHz audio', () => {
    expect(demodAll('NFM', render(fmTone(1000, 3000), 0.5)).length).toBe(24_000);
  });

  it('recovers the tone from narrow FM', () => {
    expect(toneFraction(demodAll('NFM', render(fmTone(1000, 3000), 0.5)), 1000)).toBeGreaterThan(0.9);
  });

  it('recovers the tone from wide FM', () => {
    expect(toneFraction(demodAll('WFM', render(fmTone(1000, 75_000), 0.5)), 1000)).toBeGreaterThan(0.9);
  });

  it('recovers the tone from AM', () => {
    const am: Sig = (t) => [0.3 * (1 + 0.7 * Math.cos(2 * Math.PI * 1000 * t)), 0];
    expect(toneFraction(demodAll('AM', render(am, 0.5)), 1000)).toBeGreaterThan(0.9);
  });

  const sideTone =
    (hz: number): Sig =>
    (t) => [0.3 * Math.cos(2 * Math.PI * hz * t), 0.3 * Math.sin(2 * Math.PI * hz * t)];

  it('hears 1 kHz above the carrier on USB', () => {
    expect(toneFraction(demodAll('USB', render(sideTone(1000), 0.5)), 1000)).toBeGreaterThan(0.9);
  });

  it('rejects the other sideband on USB', () => {
    const wanted = rms(demodAllNoAgc('USB', render(sideTone(1000), 0.5)));
    const unwanted = rms(demodAllNoAgc('USB', render(sideTone(-1000), 0.5)));
    expect(unwanted / wanted).toBeLessThan(0.03);
  });

  it('hears 1 kHz below the carrier on LSB', () => {
    expect(toneFraction(demodAll('LSB', render(sideTone(-1000), 0.5)), 1000)).toBeGreaterThan(0.9);
  });

  it('rejects the other sideband on LSB', () => {
    const wanted = rms(demodAllNoAgc('LSB', render(sideTone(-1000), 0.5)));
    const unwanted = rms(demodAllNoAgc('LSB', render(sideTone(1000), 0.5)));
    expect(unwanted / wanted).toBeLessThan(0.03);
  });

  it('turns a CW carrier into a 700 Hz note', () => {
    const carrier: Sig = () => [0.3, 0];
    expect(toneFraction(demodAll('CW', render(carrier, 0.5)), 700)).toBeGreaterThan(0.9);
  });

  it('rejects a signal 25 kHz away on narrow FM', () => {
    const wanted = fmTone(1000, 3000, 0.1);
    const neighbour: Sig = (t) => {
      const w = 2 * Math.PI * 25_000 * t;
      return [0.5 * Math.cos(w), 0.5 * Math.sin(w)];
    };
    const both: Sig = (t) => {
      const [a, b] = wanted(t);
      const [c, d] = neighbour(t);
      return [a + c, b + d];
    };
    expect(toneFraction(demodAll('NFM', render(both, 0.5)), 1000)).toBeGreaterThan(0.8);
  });

  it('works at the HackRF sample rate', () => {
    const fs = 4_800_000;
    const audio = demodAll('NFM', render(fmTone(1000, 3000), 0.5, fs), fs, 38_400);
    expect(audio.length).toBe(24_000);
    expect(toneFraction(audio, 1000)).toBeGreaterThan(0.9);
  });

  it('does not depend on how the samples are split into blocks', () => {
    const iq = render(fmTone(1000, 3000), 0.25);
    const whole = demodAll('NFM', iq, FS, iq.length);
    const split = demodAll('NFM', iq, FS, 4802);
    expect(split.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i += 97) expect(split[i]).toBeCloseTo(whole[i], 2);
  });

  it('refuses a sample rate that does not divide down to 240 kHz', () => {
    expect(() => new ChannelDemod('NFM', 2_048_000, 0)).toThrow(/240/);
  });

  it('keeps audio inside full scale on a very strong signal', () => {
    const audio = demodAll('AM', render((t) => [0.9 * (1 + 0.9 * Math.sin(6283 * t)), 0], 0.5));
    expect(Math.max(...audio.map(Math.abs))).toBeLessThanOrEqual(1);
  });

  it('gives the APRS decoder flat audio that it can decode', () => {
    const frame = buildUiFrame({ source: 'KE5ABC-9', destination: 'APDR16', path: ['WIDE2-1'], info: '>from IQ' });
    const audio = afskAudio(frame, 48_000);
    let phase = 0;
    const n = Math.floor((audio.length * FS) / 48_000);
    const iq = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      phase += (2 * Math.PI * (OFFSET + 3000 * audio[Math.floor((i * 48_000) / FS)])) / FS;
      iq[2 * i] = 0.3 * Math.cos(phase);
      iq[2 * i + 1] = 0.3 * Math.sin(phase);
    }
    const demod = new ChannelDemod('APRS', FS, OFFSET);
    const dec = new AfskDecoder(48_000);
    const frames = [];
    for (let i = 0; i < iq.length; i += 19_200) {
      demod.process(iq.subarray(i, i + 19_200));
      frames.push(...dec.push(demod.flatFm));
    }
    expect(frames.map((f) => f.info)).toEqual(['>from IQ']);
  });
});

function demodAllNoAgc(mode: 'USB' | 'LSB', iq: Float32Array) {
  const d = new ChannelDemod(mode, FS, OFFSET, { agc: false });
  return Float32Array.from(d.process(iq));
}
