import type { RadioDriver, RadioInfo } from './types';
import { SimWorld, type SimEmitter } from './simWorld';

const SAMPLE_RATE = 2_400_000;
const TICK_MS = 20;
const TUNE_MS = 3;
const MS_PER_DAY = 86_400_000;

/** On-air test for a repeating pattern of [start, end] seconds within each period. */
function pattern(periodS: number, spans: [number, number][]) {
  return (t: number) => {
    const at = ((t % periodS) + periodS) % periodS;
    return spans.some(([a, b]) => at >= a && at < b);
  };
}

const mhz = (x: number) => Math.round(x * 1e6);

/**
 * A made-up band plan, so the whole app can be tried with no hardware. Every
 * transmission is real modulated IQ, including APRS packets with valid checksums.
 */
const DEMO_EMITTERS: SimEmitter[] = [
  // A repeater conversation: three overs with short gaps, then a long quiet.
  { label: 'Repeater', freqHz: mhz(146.94), mode: 'NFM', levelDb: -44, on: pattern(50, [[2, 8], [9.5, 14], [15, 19]]) },
  { label: 'Simplex', freqHz: mhz(146.52), mode: 'NFM', levelDb: -48, on: pattern(37, [[20, 27]]) },
  { label: 'Repeater 2', freqHz: mhz(147.33), mode: 'NFM', levelDb: -38, on: pattern(44, [[30, 36]]) },
  { label: 'Too weak to count', freqHz: mhz(145.5), mode: 'NFM', levelDb: -74, on: () => true },
  {
    label: 'APRS',
    freqHz: mhz(144.39),
    mode: 'APRS',
    levelDb: -46,
    periodS: 9,
    packets: [
      { source: 'N0CALL-9', destination: 'APDR16', path: ['N0DIG-1*', 'WIDE2-1'], info: '=3528.46N/09730.12W>270/042 Mobile, monitoring 146.940 /A=001234' },
      { source: 'N0CALL-13', destination: 'APRS', path: ['WIDE1-1'], info: '=3530.10N/09725.40W_180/005g008t072r000p000P000h48b10162' },
      { source: 'N0DIG-1', destination: 'APN391', path: [], info: '>Demo digipeater on the hilltop' },
      { source: 'N1CALL', destination: 'APRS', path: ['N0DIG-1*'], info: ':N0CALL-9 :QSL see you on .940{12' },
      { source: 'N2CALL-7', destination: 'S32U6T', path: ['WIDE1-1', 'WIDE2-1'], info: '`(_fn"Oj/]Mic-E from a handheld=' },
    ],
  },
  {
    label: 'APRS, satellite-style',
    freqHz: mhz(145.825),
    mode: 'APRS',
    levelDb: -55,
    periodS: 23,
    startS: 4,
    packets: [{ source: 'N0SAT-4', destination: 'APRS', path: ['ARISS'], info: '>Demo orbiting digipeater' }],
  },
  { label: 'Tower', freqHz: mhz(118.3), mode: 'AM', levelDb: -42, on: pattern(25, [[3, 9], [14, 17]]) },
  { label: 'Approach', freqHz: mhz(124.85), mode: 'AM', levelDb: -50, on: pattern(31, [[10, 16]]) },
  { label: 'FM station', freqHz: mhz(98.1), mode: 'WFM', levelDb: -30, on: () => true },
  { label: 'FM station', freqHz: mhz(101.5), mode: 'WFM', levelDb: -36, on: () => true },
  { label: 'Ragchew', freqHz: mhz(14.25), mode: 'USB', levelDb: -48, on: pattern(29, [[4, 12], [13, 19]]) },
  { label: 'Net', freqHz: mhz(7.2), mode: 'LSB', levelDb: -46, on: pattern(33, [[5, 15]]) },
  { label: 'CW', freqHz: mhz(14.03), mode: 'CW', levelDb: -50, on: pattern(27, [[2, 15]]) },
  { label: 'Marine', freqHz: mhz(156.8), mode: 'NFM', levelDb: -45, on: pattern(41, [[6, 12]]) },
  { label: 'UHF', freqHz: mhz(446), mode: 'NFM', levelDb: -47, on: pattern(35, [[8, 14]]) },
];

export class DemoRadio implements RadioDriver {
  readonly info: RadioInfo;
  readonly latencySamples = 0;
  private readonly world: SimWorld;
  private center = 100e6;
  private timer: ReturnType<typeof setInterval> | null = null;
  private buffer = new Float32Array(0);

  constructor(private readonly index: number) {
    this.info = {
      kind: 'demo',
      name: `Demo radio ${index + 1}`,
      minHz: 500_000,
      maxHz: 6_000_000_000,
      sampleRate: SAMPLE_RATE,
      maxGainDb: 50,
      defaultGainDb: 30,
    };
    this.world = new SimWorld(
      DEMO_EMITTERS.map((e) => ({ ...e, levelDb: this.levelOf(e.freqHz) })),
      0.004,
      index + 1,
    );
  }

  /** Each demo radio hears each transmitter differently, as two real antennas would. */
  levelOf(freqHz: number): number {
    const emitter = DEMO_EMITTERS.find((e) => e.freqHz === freqHz);
    const base = emitter?.levelDb ?? -60;
    if (this.index === 0) return base;
    return base + (Math.round(freqHz / 1000) % 2 === 0 ? 8 : -8) * (this.index % 2 ? 1 : -1);
  }

  async open() {}

  async setFrequency(hz: number) {
    await new Promise((resolve) => setTimeout(resolve, TUNE_MS));
    this.center = hz;
  }

  async setGainDb() {}

  async setPpm() {}

  async start(onIq: (iq: Float32Array) => void, _onError: (error: Error) => void) {
    let last = performance.now();
    let t = (Date.now() % MS_PER_DAY) / 1000;
    this.timer = setInterval(() => {
      const now = performance.now();
      const n = Math.min(SAMPLE_RATE / 5, Math.round(((now - last) / 1000) * SAMPLE_RATE));
      last = now;
      if (n <= 0) return;
      if (this.buffer.length !== n * 2) this.buffer = new Float32Array(n * 2);
      this.world.render(this.center, SAMPLE_RATE, t, this.buffer);
      t += n / SAMPLE_RATE;
      onIq(this.buffer);
    }, TICK_MS);
  }

  async stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async close() {
    await this.stop();
  }
}
