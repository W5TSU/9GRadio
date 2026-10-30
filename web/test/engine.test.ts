import { describe, expect, it } from 'vitest';
import { ScanEngine, planSlices, type ScanConfig, type ScanEvent } from '../src/scan/engine';
import { SimWorld, type SimEmitter } from '../src/radio/simWorld';

const FS = 960_000;
const BLOCK_MS = 4;

class Harness {
  now = 1000;
  center = 0;
  events: ScanEvent[] = [];
  tunes: number[] = [];
  readonly engine: ScanEngine;
  private readonly world: SimWorld;
  private readonly iq = new Float32Array(Math.round((FS * BLOCK_MS) / 1000) * 2);
  private t: number;

  constructor(emitters: SimEmitter[], startT = 0) {
    this.t = startT;
    this.world = new SimWorld(emitters);
    this.engine = new ScanEngine({
      sampleRate: FS,
      latencySamples: 0,
      now: () => this.now,
      tune: async (hz) => {
        this.tunes.push(hz);
        this.center = hz;
      },
      emit: (e) => this.events.push(e),
    });
  }

  async run(ms: number) {
    const blocks = Math.ceil(ms / BLOCK_MS);
    for (let b = 0; b < blocks; b++) {
      this.world.render(this.center, FS, this.t, this.iq);
      this.engine.pushIq(this.iq);
      this.now += BLOCK_MS;
      this.t += BLOCK_MS / 1000;
      await Promise.resolve();
      await Promise.resolve();
    }
  }

  of<T extends ScanEvent['type']>(type: T) {
    return this.events.filter((e): e is Extract<ScanEvent, { type: T }> => e.type === type);
  }
}

const cfg = (over: Partial<ScanConfig> = {}): ScanConfig => ({
  startHz: 146_400_000,
  stopHz: 146_600_000,
  stepHz: 5_000,
  mode: 'NFM',
  marginDb: 12,
  minStayMs: 400,
  delayMs: 200,
  ...over,
});

const carrier = (freqHz: number, levelDb = -40, on?: SimEmitter['on']): SimEmitter => ({
  freqHz,
  mode: 'CARRIER',
  levelDb,
  on,
});

describe('planSlices', () => {
  const fs = 2_400_000;

  it('fits a narrow band in one slice, clear of the center', () => {
    const [c, ...rest] = planSlices(144_380_000, 144_400_000, fs, 0);
    expect(rest).toEqual([]);
    expect(Math.abs(144_380_000 - c)).toBeGreaterThan(50_000);
    expect(Math.abs(144_400_000 - c)).toBeGreaterThan(50_000);
    expect(144_400_000 - c).toBeLessThan(0.45 * fs);
  });

  it.each([0, 1])('covers a wide band without gaps on sweep %i', (sweep) => {
    const start = 144_000_000;
    const stop = 148_000_000;
    const slices = planSlices(start, stop, fs, sweep);
    expect(slices[0] - 0.45 * fs).toBeLessThanOrEqual(start);
    expect(slices[slices.length - 1] + 0.45 * fs).toBeGreaterThanOrEqual(stop);
    for (let i = 1; i < slices.length; i++) {
      expect(slices[i] - slices[i - 1]).toBeLessThanOrEqual(0.9 * fs);
    }
  });

  it('keeps the tuned frequency inside what the radio can reach', () => {
    const [c] = planSlices(550_000, 570_000, fs, 0, 500_000);
    expect(c).toBeGreaterThanOrEqual(500_000);
    expect(Math.abs(560_000 - c)).toBeGreaterThan(50_000);
    expect(Math.abs(560_000 - c)).toBeLessThan(0.45 * fs);
  });

  it('moves the slice centers on alternate sweeps so nothing stays hidden at DC', () => {
    const a = planSlices(144_000_000, 148_000_000, fs, 0);
    const b = planSlices(144_000_000, 148_000_000, fs, 1);
    for (const c of b) {
      for (const d of a) expect(Math.abs(c - d)).toBeGreaterThan(100_000);
    }
  });
});

describe('ScanEngine: finding signals', () => {
  it('stops on a strong signal and reports it snapped to the step', async () => {
    const h = new Harness([carrier(146_521_300)]);
    h.engine.start(cfg());
    await h.run(100);
    const [hit] = h.of('hit');
    expect(hit.freqHz).toBe(146_520_000);
    expect(hit.stopped).toBe(true);
    expect(hit.mode).toBe('NFM');
    expect(hit.levelDb).toBeGreaterThan(-45);
    expect(hit.snrDb).toBeGreaterThan(12);
    expect(h.of('parked')[0].freqHz).toBe(146_520_000);
  });

  it('does not stop on a signal under the strong line', async () => {
    const h = new Harness([carrier(146_520_000, -80)]);
    h.engine.start(cfg());
    await h.run(200);
    expect(h.of('hit')).toEqual([]);
    expect(h.of('parked')).toEqual([]);
  });

  it('moving the strong line up makes the same signal too weak', async () => {
    const h = new Harness([carrier(146_520_000, -60)]);
    h.engine.start(cfg({ marginDb: 40 }));
    await h.run(200);
    expect(h.of('hit')).toEqual([]);
  });

  it('ignores a signal outside the band', async () => {
    const h = new Harness([carrier(146_650_000)]);
    h.engine.start(cfg());
    await h.run(200);
    expect(h.of('hit')).toEqual([]);
  });

  it('ignores a skipped frequency when it is found', async () => {
    const h = new Harness([carrier(146_520_000)]);
    h.engine.setSkips([146_520_000]);
    h.engine.start(cfg());
    await h.run(200);
    expect(h.of('hit')).toEqual([]);
  });

  it('counts a skip as covering the whole channel', async () => {
    const h = new Harness([carrier(146_525_000)]);
    h.engine.setSkips([146_520_000]);
    h.engine.start(cfg());
    await h.run(200);
    expect(h.of('hit')).toEqual([]);
  });

  it('still finds a signal next to a skipped channel', async () => {
    const h = new Harness([carrier(146_540_000)]);
    h.engine.setSkips([146_520_000]);
    h.engine.start(cfg());
    await h.run(200);
    expect(h.of('hit')[0]?.freqHz).toBe(146_540_000);
  });

  it('plays the strongest and logs the others in the same slice', async () => {
    const h = new Harness([carrier(146_450_000, -50), carrier(146_520_000, -30)]);
    h.engine.start(cfg());
    await h.run(100);
    const hits = h.of('hit');
    expect(hits.find((x) => x.stopped)?.freqHz).toBe(146_520_000);
    expect(hits.find((x) => !x.stopped)?.freqHz).toBe(146_450_000);
    expect(h.of('parked')).toHaveLength(1);
  });

  it('sweeps a wide band by retuning, and finds a signal in a later slice', async () => {
    const h = new Harness([carrier(149_123_000, -40)]);
    h.engine.start(cfg({ startHz: 146_000_000, stopHz: 150_000_000 }));
    await h.run(300);
    expect(new Set(h.tunes).size).toBeGreaterThan(3);
    expect(h.of('hit')[0]?.freqHz).toBe(149_125_000);
  });

  it('finds a signal that sits exactly where the slice center would be', async () => {
    const start = 146_000_000;
    const onCenter = planSlices(start, 150_000_000, FS, 0)[1];
    const h = new Harness([carrier(onCenter)]);
    h.engine.start(cfg({ startHz: start, stopHz: 150_000_000, stepHz: 1000 }));
    await h.run(1500);
    expect(h.of('hit').length).toBeGreaterThan(0);
  });

  it('reports the spectrum and the strong line it is measuring against', async () => {
    const h = new Harness([]);
    h.engine.start(cfg());
    await h.run(100);
    const s = h.of('spectrum')[0];
    expect(s.thresholdDb).toBeCloseTo(s.floorDb + 12, 5);
    expect(s.db.length).toBeGreaterThan(100);
    expect(s.binHz).toBeGreaterThan(0);
    expect(s.startHz).toBeLessThan(146_400_000);
  });

  it('keeps away from the DC spike by retuning before parking on a signal near the center', async () => {
    const h = new Harness([carrier(146_500_000)]);
    const narrow = cfg({ startHz: 146_490_000, stopHz: 146_510_000 });
    h.engine.start(narrow);
    await h.run(50);
    const park = h.tunes[h.tunes.length - 1];
    expect(Math.abs(146_500_000 - park)).toBeGreaterThan(20_000);
    expect(Math.abs(146_500_000 - park)).toBeLessThan(FS * 0.45);
  });
});

describe('ScanEngine: the stop rule in action', () => {
  it('releases after n and x once the signal is gone, then scans again', async () => {
    const h = new Harness([carrier(146_520_000, -40, (t) => t < 0.2)]);
    h.engine.start(cfg());
    await h.run(1000);
    const parked = h.events.findIndex((e) => e.type === 'parked');
    const released = h.of('released');
    expect(parked).toBeGreaterThanOrEqual(0);
    expect(released).toHaveLength(1);
    expect(released[0].freqHz).toBe(146_520_000);
    const heldFor = released[0].heldMs;
    expect(heldFor).toBeGreaterThanOrEqual(600);
    expect(heldFor).toBeLessThan(800);
  });

  it('stays parked for as long as a carrier stays on', async () => {
    const h = new Harness([carrier(146_520_000)]);
    h.engine.start(cfg());
    await h.run(2000);
    expect(h.of('released')).toEqual([]);
  });

  it('stops on the same signal again when it comes back', async () => {
    const h = new Harness([carrier(146_520_000, -40, (t) => t < 0.1 || (t > 1.5 && t < 1.6))]);
    h.engine.start(cfg());
    await h.run(2000);
    expect(h.of('parked').length).toBe(2);
    expect(h.of('hit').length).toBe(2);
  });

  it('next() leaves at once and does not come straight back', async () => {
    const h = new Harness([carrier(146_520_000)]);
    h.engine.start(cfg());
    await h.run(100);
    h.engine.next();
    const at = h.events.length;
    expect(h.of('released')).toHaveLength(1);
    await h.run(1000);
    expect(h.events.slice(at).filter((e) => e.type === 'parked')).toEqual([]);
  });

  it('after next() the signal is found again once the pause is over', async () => {
    const h = new Harness([carrier(146_520_000)]);
    h.engine.start(cfg());
    await h.run(100);
    h.engine.next();
    await h.run(5500);
    expect(h.of('parked').length).toBe(2);
  });

  it('setSkips releases a radio parked on that frequency', async () => {
    const h = new Harness([carrier(146_520_000)]);
    h.engine.start(cfg());
    await h.run(100);
    h.engine.setSkips([146_520_000]);
    expect(h.of('released')).toHaveLength(1);
    const at = h.events.length;
    await h.run(6000);
    expect(h.events.slice(at).filter((e) => e.type === 'parked')).toEqual([]);
  });

  it('setExcludes releases a radio parked on that frequency', async () => {
    const h = new Harness([carrier(146_520_000)]);
    h.engine.start(cfg());
    await h.run(100);
    h.engine.setExcludes([146_520_000]);
    expect(h.of('released')).toHaveLength(1);
  });

  it('an excluded frequency is found again once the exclusion is lifted', async () => {
    const h = new Harness([carrier(146_520_000)]);
    h.engine.setExcludes([146_520_000]);
    h.engine.start(cfg());
    await h.run(100);
    expect(h.of('parked')).toEqual([]);
    h.engine.setExcludes([]);
    await h.run(100);
    expect(h.of('parked')).toHaveLength(1);
  });

  it('stop() leaves the radio idle and quiet', async () => {
    const h = new Harness([carrier(146_520_000)]);
    h.engine.setAudioEnabled(true);
    h.engine.start(cfg());
    await h.run(100);
    h.engine.stop();
    const at = h.events.length;
    await h.run(100);
    expect(h.events.slice(at)).toEqual([]);
  });
});

describe('ScanEngine: one transmitter is one signal', () => {
  // The demo clock runs from midnight, so these also cover a transmitter late in the day.
  const LATE = 50_000;

  it.each([
    ['AM', 118_300_000, 25_000, 118_200_000, 118_400_000],
    ['USB', 14_250_000, 1_000, 14_200_000, 14_300_000],
    ['LSB', 7_200_000, 1_000, 7_150_000, 7_250_000],
  ] as const)('%s voice is found only at its own frequency', async (mode, freqHz, stepHz, startHz, stopHz) => {
    const h = new Harness([{ freqHz, mode, levelDb: -45, on: () => true }], LATE);
    h.engine.start(cfg({ mode, stepHz, startHz, stopHz, minStayMs: 100, delayMs: 100 }));
    await h.run(3000);
    const found = new Set(h.of('hit').map((x) => x.freqHz));
    expect(found.size).toBeGreaterThan(0);
    for (const f of found) expect(Math.abs(f - freqHz)).toBeLessThanOrEqual(1_000);
  });
});

describe('ScanEngine: radio limits', () => {
  it('parks above a signal it cannot park below', async () => {
    const tunes: number[] = [];
    const engine = new ScanEngine({
      sampleRate: FS,
      latencySamples: 0,
      minHz: 500_000,
      now: () => 0,
      tune: async (hz) => void tunes.push(hz),
      emit: () => {},
    });
    const world = new SimWorld([carrier(600_000)]);
    engine.start(cfg({ startHz: 590_000, stopHz: 610_000 }));
    const iq = new Float32Array(38_400);
    for (let i = 0; i < 20; i++) {
      world.render(tunes[tunes.length - 1] ?? 0, FS, i * 0.02, iq);
      engine.pushIq(iq);
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(Math.min(...tunes)).toBeGreaterThanOrEqual(500_000);
  });
});

describe('ScanEngine: radio failures', () => {
  it('reports a failed retune and stops scanning', async () => {
    const events: ScanEvent[] = [];
    const engine = new ScanEngine({
      sampleRate: FS,
      latencySamples: 0,
      now: () => 0,
      tune: () => Promise.reject(new Error('USB gone')),
      emit: (e) => events.push(e),
    });
    engine.start(cfg());
    await Promise.resolve();
    await Promise.resolve();
    const failure = events.find((e) => e.type === 'error');
    expect(failure).toEqual({ type: 'error', message: 'USB gone' });
    const last = events.filter((e) => e.type === 'status').pop();
    expect(last).toMatchObject({ phase: 'idle' });
  });
});

describe('ScanEngine: audio', () => {
  const voiceAt = (on: SimEmitter['on']): SimEmitter => ({ freqHz: 146_520_000, mode: 'NFM', levelDb: -40, on });

  it('sends no audio unless this radio has been told to play', async () => {
    const h = new Harness([voiceAt(undefined)]);
    h.engine.start(cfg());
    await h.run(200);
    expect(h.of('audio')).toEqual([]);
  });

  it('sends audio while the signal is on', async () => {
    const h = new Harness([voiceAt(undefined)]);
    h.engine.setAudioEnabled(true);
    h.engine.start(cfg());
    await h.run(300);
    const total = h.of('audio').reduce((s, e) => s + e.samples.length, 0);
    expect(total).toBeGreaterThan(48_000 * 0.2);
  });

  it('goes silent while parked with the signal off', async () => {
    const h = new Harness([voiceAt((t) => t < 0.1)]);
    h.engine.setAudioEnabled(true);
    h.engine.start(cfg({ minStayMs: 5000 }));
    await h.run(600);
    const at = h.events.length;
    await h.run(500);
    expect(h.events.slice(at).filter((e) => e.type === 'audio')).toEqual([]);
    expect(h.of('released')).toEqual([]);
  });

  it('delivers independent audio blocks that later processing cannot overwrite', async () => {
    const h = new Harness([voiceAt(undefined)]);
    h.engine.setAudioEnabled(true);
    h.engine.start(cfg());
    await h.run(200);
    const blocks = h.of('audio');
    expect(blocks[0].samples.buffer).not.toBe(blocks[1].samples.buffer);
  });
});

describe('ScanEngine: APRS', () => {
  const aprsCfg = (over: Partial<ScanConfig> = {}) =>
    cfg({ startHz: 144_380_000, stopHz: 144_400_000, mode: 'APRS', ...over });
  const station: SimEmitter = {
    freqHz: 144_390_000,
    mode: 'APRS',
    levelDb: -40,
    periodS: 2,
    startS: 0.05,
    packets: [{ source: 'KE5ABC-9', destination: 'APDR16', path: ['WIDE2-1'], info: '>hello' }],
  };

  it('logs a hit only after a packet passes its check', async () => {
    const h = new Harness([station]);
    h.engine.start(aprsCfg());
    await h.run(1200);
    const [p] = h.of('packet');
    expect(p.packet.source).toBe('KE5ABC-9');
    expect(p.packet.comment).toBe('hello');
    expect(p.freqHz).toBe(144_390_000);
    expect(p.levelDb).toBeGreaterThan(-50);
    expect(h.of('hit')[0].freqHz).toBe(144_390_000);
    expect(h.of('parked')).toHaveLength(1);
  });

  it('ignores a carrier that carries no packets: no hit, no park, no audio', async () => {
    const h = new Harness([carrier(144_390_000)]);
    h.engine.setAudioEnabled(true);
    h.engine.start(aprsCfg());
    await h.run(4000);
    expect(h.of('hit')).toEqual([]);
    expect(h.of('parked')).toEqual([]);
    expect(h.of('audio')).toEqual([]);
  });

  it('gives up on a non-APRS signal at the 3 second limit', async () => {
    const h = new Harness([carrier(144_390_000)]);
    h.engine.start(aprsCfg());
    await h.run(3200);
    const statuses = h.of('status').map((s) => s.phase);
    expect(statuses).toContain('probing');
    expect(statuses[statuses.length - 1]).toBe('scanning');
  });

  it('does not keep probing a steady carrier that just failed', async () => {
    const h = new Harness([carrier(144_390_000)]);
    h.engine.start(aprsCfg());
    await h.run(3300);
    const probesBefore = h.of('status').filter((s) => s.phase === 'probing').length;
    await h.run(3000);
    expect(h.of('status').filter((s) => s.phase === 'probing').length).toBe(probesBefore);
  });

  it('keeps decoding packets after parking', async () => {
    const h = new Harness([station]);
    h.engine.start(aprsCfg({ minStayMs: 10_000 }));
    await h.run(5000);
    expect(h.of('packet').length).toBeGreaterThanOrEqual(2);
    expect(h.of('parked')).toHaveLength(1);
  });

  it('tries again soon after a short burst it could not decode', async () => {
    const shortBurst = carrier(144_390_000, -40, (t) => t < 0.2 || (t > 1 && t < 1.2));
    const h = new Harness([shortBurst]);
    h.engine.start(aprsCfg());
    await h.run(1500);
    const probing = h.of('status').filter((s) => s.phase === 'probing');
    expect(new Set(probing.map((s) => s.sinceMs)).size).toBe(2);
  });
});
