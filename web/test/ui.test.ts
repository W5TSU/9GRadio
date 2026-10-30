import { describe, expect, it } from 'vitest';
import { bandProblem, fmtClock, fmtMhz, fmtStay, spectrumToColumns, BAND_PRESETS } from '../src/ui/format';
import { RadioSources, sourceMatches, sourceOrdinal } from '../src/radio/sources';
import { voice } from '../src/radio/simWorld';
import { PowerSpectrum } from '../src/dsp/spectrum';
import type { RadioInfo } from '../src/radio/types';
import { DemoRadio } from '../src/radio/demo';
import { explainUsbError } from '../src/radio/usbErrors';
import { defaultSettings, loadSettings } from '../src/app/settings';

const rtl: RadioInfo = {
  kind: 'rtlsdr',
  name: 'RTL',
  minHz: 24_000_000,
  maxHz: 1_766_000_000,
  sampleRate: 2_400_000,
  maxGainDb: 49.6,
  defaultGainDb: 33.8,
};

describe('fmtMhz', () => {
  it('shows three decimals when that is exact', () => {
    expect(fmtMhz(146_520_000)).toBe('146.520');
  });
  it('shows more decimals when the frequency needs them', () => {
    expect(fmtMhz(146_506_250)).toBe('146.50625');
    expect(fmtMhz(14_074_100)).toBe('14.0741');
  });
});

describe('fmtStay', () => {
  it('counts down the minimum stay', () => {
    expect(fmtStay('hold', 6000, true)).toBe('Holding: 6 s left of the minimum stay');
  });
  it('shows the signal is keeping it', () => {
    expect(fmtStay('play', 0, true)).toBe('Signal on');
  });
  it('counts down the reply delay', () => {
    expect(fmtStay('delay', 2100, false)).toBe('Waiting for a reply: 3 s');
  });
});

describe('fmtClock', () => {
  it('pads hours, minutes and seconds', () => {
    expect(fmtClock(new Date(2026, 9, 30, 4, 5, 6).getTime())).toBe('04:05:06');
  });
});

describe('bandProblem', () => {
  const ok = { startHz: 144_000_000, stopHz: 148_000_000, stepHz: 5000 };

  it('accepts a band the radio can reach', () => {
    expect(bandProblem(ok, rtl)).toBeNull();
  });
  it('rejects a band below the radio', () => {
    expect(bandProblem({ ...ok, startHz: 7_000_000, stopHz: 7_300_000 }, rtl)).toMatch(/24\.000/);
  });
  it('rejects a band above the radio', () => {
    expect(bandProblem({ ...ok, startHz: 1_800_000_000, stopHz: 1_900_000_000 }, rtl)).toMatch(/1766/);
  });
  it('rejects a start at or above the stop', () => {
    expect(bandProblem({ ...ok, startHz: 148_000_000, stopHz: 148_000_000 }, rtl)).toMatch(/below/i);
  });
  it('rejects a missing or zero step', () => {
    expect(bandProblem({ ...ok, stepHz: 0 }, rtl)).toMatch(/step/i);
    expect(bandProblem({ ...ok, stepHz: NaN }, rtl)).toMatch(/step/i);
  });
  it('rejects numbers that did not parse', () => {
    expect(bandProblem({ ...ok, startHz: NaN }, rtl)).toMatch(/number/i);
  });
});

describe('BAND_PRESETS', () => {
  it('has a usable band for every preset', () => {
    const everything: RadioInfo = { ...rtl, minHz: 1, maxHz: 7e9 };
    for (const p of BAND_PRESETS) expect(bandProblem(p, everything), p.name).toBeNull();
  });
  it('watches the APRS calling frequencies', () => {
    const na = BAND_PRESETS.find((p) => p.mode === 'APRS' && p.startHz < 144_390_000 && p.stopHz > 144_390_000);
    const eu = BAND_PRESETS.find((p) => p.mode === 'APRS' && p.startHz < 144_800_000 && p.stopHz > 144_800_000);
    expect(na).toBeDefined();
    expect(eu).toBeDefined();
  });
});

describe('spectrumToColumns', () => {
  const band = { startHz: 100, stopHz: 200 };

  it('writes each bin into its column, keeping the strongest', () => {
    const cols = new Float32Array(10).fill(-100);
    spectrumToColumns(cols, band, 100, 5, Float32Array.of(-50, -40, -60, -70));
    expect(cols[0]).toBe(-40);
    expect(cols[1]).toBe(-60);
    expect(cols[2]).toBe(-100);
  });

  it('replaces the old values in the part of the band it covers', () => {
    const cols = new Float32Array(10).fill(-10);
    spectrumToColumns(cols, band, 100, 10, Float32Array.of(-50));
    expect(cols[0]).toBe(-50);
    expect(cols[1]).toBe(-10);
  });

  it('ignores bins outside the band', () => {
    const cols = new Float32Array(10).fill(-100);
    spectrumToColumns(cols, band, 50, 25, Float32Array.of(0, 0, -50, -50, -50, -50, 0, 0));
    expect([...cols]).toEqual(new Array(10).fill(-50));
  });

  it('fills every column when bins are wider than columns', () => {
    const cols = new Float32Array(10).fill(-100);
    spectrumToColumns(cols, band, 100, 50, Float32Array.of(-30, -40));
    expect([...cols]).toEqual([-30, -30, -30, -30, -30, -40, -40, -40, -40, -40]);
  });
});

describe('voice in the demo radio', () => {
  it('stays in the voice band however long the demo has been running', () => {
    const n = 4096;
    const iq = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) iq[2 * i] = voice(50_000 + i / 48_000);
    const db = new PowerSpectrum(n).compute(iq);
    let inBand = 0;
    let total = 0;
    for (let i = 0; i < n; i++) {
      const hz = Math.abs(i - n / 2) * (48_000 / n);
      const p = 10 ** (db[i] / 10);
      total += p;
      if (hz < 4_000) inBand += p;
    }
    expect(inBand / total).toBeGreaterThan(0.95);
  });
});

describe('sourceMatches', () => {
  const source = { kind: 'usb' as const, vendorId: 1, productId: 2, serial: 'A', ordinal: 0 };

  it('recognises the device a radio was opened from', () => {
    expect(sourceMatches(source, { vendorId: 1, productId: 2, serialNumber: 'A' })).toBe(true);
  });
  it('rejects a different device', () => {
    expect(sourceMatches(source, { vendorId: 1, productId: 2, serialNumber: 'B' })).toBe(false);
    expect(sourceMatches(source, { vendorId: 9, productId: 2, serialNumber: 'A' })).toBe(false);
  });
  it('never matches a demo radio', () => {
    expect(sourceMatches({ kind: 'demo', index: 0 }, { vendorId: 1, productId: 2, serialNumber: 'A' })).toBe(false);
  });
});

describe('sourceOrdinal', () => {
  const d = (vendorId: number, productId: number, serialNumber: string | null) => ({ vendorId, productId, serialNumber });

  it('tells apart two dongles that share a serial number', () => {
    const list = [d(1, 2, 'A'), d(1, 2, 'B'), d(1, 2, 'A')];
    expect(sourceOrdinal(list, list[0])).toBe(0);
    expect(sourceOrdinal(list, list[2])).toBe(1);
    expect(sourceOrdinal(list, list[1])).toBe(0);
  });

  it('finds the same device again from its description', () => {
    const list = [d(1, 2, 'A'), d(1, 2, 'A')];
    expect(RadioSources.pick(list, { vendorId: 1, productId: 2, serial: 'A', ordinal: 1 })).toBe(list[1]);
    expect(RadioSources.pick(list, { vendorId: 9, productId: 2, serial: 'A', ordinal: 0 })).toBeUndefined();
  });
});

describe('explainUsbError', () => {
  const named = (name: string, message: string) => Object.assign(new Error(message), { name });

  it('points at the TV driver when a dongle is already claimed', () => {
    const text = explainUsbError(named('NetworkError', 'Unable to claim interface.'), 'rtlsdr');
    expect(text).toMatch(/dvb_usb_rtl28xxu/);
  });

  it('does not mention the TV driver for a HackRF', () => {
    const text = explainUsbError(named('NetworkError', 'Unable to claim interface.'), 'hackrf');
    expect(text).not.toMatch(/dvb/);
    expect(text).toMatch(/other program/i);
  });

  it('points at the permissions file when the device is refused', () => {
    expect(explainUsbError(named('SecurityError', 'Access denied.'), 'hackrf')).toMatch(/udev/);
  });

  it('points at the permissions file when the device cannot be opened', () => {
    expect(explainUsbError(named('NetworkError', 'Failed to open the device.'), 'rtlsdr')).toMatch(/udev/);
  });

  it('passes other messages through', () => {
    expect(explainUsbError(new Error('This dongle has an E4000 tuner'), 'rtlsdr')).toMatch(/E4000/);
  });
});

describe('loadSettings', () => {
  const store = (value: string | null) => ({ getItem: () => value, setItem: () => {} });

  it('uses the defaults when nothing is saved', () => {
    expect(loadSettings(store(null), 'k', defaultSettings(rtl)).marginDb).toBe(12);
  });

  it('restores what was saved', () => {
    const saved = JSON.stringify({ ...defaultSettings(rtl), marginDb: 20 });
    expect(loadSettings(store(saved), 'k', defaultSettings(rtl)).marginDb).toBe(20);
  });

  it('fills in fields added since the settings were saved', () => {
    expect(loadSettings(store('{"marginDb": 20}'), 'k', defaultSettings(rtl)).minStayS).toBe(10);
  });

  it('falls back to the defaults on damaged data', () => {
    expect(loadSettings(store('{not json'), 'k', defaultSettings(rtl)).marginDb).toBe(12);
  });

  it('starts with n = 10 s, x = 3 s and the radio\'s own gain', () => {
    expect(defaultSettings(rtl)).toMatchObject({ minStayS: 10, delayS: 3, gainDb: 33.8 });
  });
});

describe('DemoRadio', () => {
  it('delivers samples at about the rate it claims, once started', async () => {
    const radio = new DemoRadio(0);
    await radio.open();
    await radio.setFrequency(146_000_000);
    let samples = 0;
    await radio.start((iq) => (samples += iq.length / 2), () => {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    await radio.stop();
    const rate = samples / 0.2;
    expect(rate).toBeGreaterThan(radio.info.sampleRate * 0.5);
    expect(rate).toBeLessThan(radio.info.sampleRate * 1.5);
  });

  it('stops delivering after stop', async () => {
    const radio = new DemoRadio(0);
    await radio.open();
    let blocks = 0;
    await radio.start(() => blocks++, () => {});
    await new Promise((resolve) => setTimeout(resolve, 60));
    await radio.stop();
    const at = blocks;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(blocks).toBe(at);
  });

  it('hears the same transmitter at a different strength on the second radio', () => {
    expect(new DemoRadio(0).levelOf(146_520_000)).not.toBe(new DemoRadio(1).levelOf(146_520_000));
  });
});
