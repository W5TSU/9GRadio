import { describe, expect, it } from 'vitest';
import { PowerSpectrum } from '../src/dsp/spectrum';
import { detectSignals, noiseFloorDb } from '../src/scan/detect';

function tone(n: number, cycles: number, amp = 1, phase = 0) {
  const iq = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * cycles * i) / n + phase;
    iq[2 * i] = amp * Math.cos(a);
    iq[2 * i + 1] = amp * Math.sin(a);
  }
  return iq;
}

describe('PowerSpectrum', () => {
  it('puts DC in the middle bin and a positive tone above it', () => {
    const s = new PowerSpectrum(1024);
    const db = s.compute(tone(1024, 100));
    let peak = 0;
    for (let i = 0; i < 1024; i++) if (db[i] > db[peak]) peak = i;
    expect(peak).toBe(512 + 100);
  });

  it('places a negative tone below the middle bin', () => {
    const s = new PowerSpectrum(1024);
    const db = s.compute(tone(1024, -40));
    let peak = 0;
    for (let i = 0; i < 1024; i++) if (db[i] > db[peak]) peak = i;
    expect(peak).toBe(512 - 40);
  });

  it('reads a full scale tone as 0 dBFS and a -20 dB tone as -20 dBFS', () => {
    const s = new PowerSpectrum(1024);
    expect(Math.max(...s.compute(tone(1024, 100)))).toBeCloseTo(0, 1);
    expect(Math.max(...s.compute(tone(1024, 100, 0.1)))).toBeCloseTo(-20, 1);
  });

  it('averages blocks in power, not in dB', () => {
    const s = new PowerSpectrum(1024);
    const iq = new Float32Array(1024 * 4);
    iq.set(tone(1024, 100), 0);
    // Second block is silent: average power is half, so 3 dB down.
    expect(Math.max(...s.compute(iq, 2))).toBeCloseTo(-3, 1);
  });
});

describe('noiseFloorDb', () => {
  it('uses the median so a few strong signals do not raise it', () => {
    const db = new Float32Array(1000).fill(-80);
    db.fill(-10, 100, 150);
    expect(noiseFloorDb(db)).toBe(-80);
  });
});

describe('detectSignals', () => {
  const opts = (over = {}) => ({
    centerHz: 146_000_000,
    binHz: 1000,
    thresholdDb: -68,
    mergeGapHz: 2000,
    dcGuardHz: 3000,
    edgeFraction: 0.03,
    ...over,
  });
  const floor = () => new Float32Array(2048).fill(-80);

  it('finds one signal at its frequency and level', () => {
    const db = floor();
    db[1024 + 200] = -40;
    const [s] = detectSignals(db, opts());
    expect(s.peakHz).toBe(146_200_000);
    expect(s.peakDb).toBe(-40);
    expect(s.lowHz).toBe(146_200_000);
    expect(s.highHz).toBe(146_200_000);
  });

  it('ignores a signal under the line', () => {
    const db = floor();
    db[1224] = -69;
    expect(detectSignals(db, opts())).toEqual([]);
  });

  it('merges bins across a small gap into one signal with a power centroid', () => {
    const db = floor();
    db[1224] = -40;
    db[1226] = -40;
    const found = detectSignals(db, opts());
    expect(found).toHaveLength(1);
    expect(found[0].centerHz).toBe(146_201_000);
    expect(found[0].lowHz).toBe(146_200_000);
    expect(found[0].highHz).toBe(146_202_000);
  });

  it('keeps signals apart when the gap is wider than the merge gap', () => {
    const db = floor();
    db[1224] = -40;
    db[1228] = -40;
    expect(detectSignals(db, opts())).toHaveLength(2);
  });

  it('ignores the DC spike at the center of the slice', () => {
    const db = floor();
    db[1024] = 0;
    db[1026] = 0;
    expect(detectSignals(db, opts())).toEqual([]);
  });

  it('ignores the rolled-off edges of the slice', () => {
    const db = floor();
    db[10] = -20;
    db[2040] = -20;
    expect(detectSignals(db, opts())).toEqual([]);
  });
});
