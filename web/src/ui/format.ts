import type { Mode } from '../dsp/demod';
import type { RadioInfo } from '../radio/types';
import type { StopState } from '../scan/stopRule';

export function fmtMhz(hz: number): string {
  const mhz = (hz / 1e6).toFixed(6).replace(/0+$/, '');
  const [whole, frac = ''] = mhz.split('.');
  return `${whole}.${frac.padEnd(3, '0')}`;
}

export function fmtClock(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

export function fmtStay(state: StopState, remainingMs: number, signalOn: boolean): string {
  const left = Math.ceil(remainingMs / 1000);
  switch (state) {
    case 'hold':
      return `Holding: ${left} s left of the minimum stay`;
    case 'delay':
      return `Waiting for a reply: ${left} s`;
    default:
      return signalOn ? 'Signal on' : '';
  }
}

export interface BandFields {
  startHz: number;
  stopHz: number;
  stepHz: number;
}

/** Why a band can't be scanned on this radio, or null if it can. */
export function bandProblem(b: BandFields, info: Pick<RadioInfo, 'minHz' | 'maxHz'>): string | null {
  if (!Number.isFinite(b.startHz) || !Number.isFinite(b.stopHz)) return 'Start and stop must be numbers.';
  if (!Number.isFinite(b.stepHz) || b.stepHz <= 0) return 'The step must be more than 0.';
  if (b.startHz >= b.stopHz) return 'The start must be below the stop.';
  if (b.startHz < info.minHz) return `This radio can't tune below ${(info.minHz / 1e6).toFixed(3)} MHz.`;
  if (b.stopHz > info.maxHz) return `This radio can't tune above ${(info.maxHz / 1e6).toFixed(0)} MHz.`;
  return null;
}

export interface BandPreset extends BandFields {
  name: string;
  mode: Mode;
}

const mhz = (x: number) => Math.round(x * 1e6);

export const BAND_PRESETS: BandPreset[] = [
  { name: '2 m ham, 144-148 MHz', startHz: mhz(144), stopHz: mhz(148), stepHz: 5_000, mode: 'NFM' },
  { name: '70 cm ham, 420-450 MHz', startHz: mhz(420), stopHz: mhz(450), stepHz: 12_500, mode: 'NFM' },
  { name: 'APRS, 144.390 (North America)', startHz: mhz(144.38), stopHz: mhz(144.4), stepHz: 5_000, mode: 'APRS' },
  { name: 'APRS, 144.800 (Europe)', startHz: mhz(144.79), stopHz: mhz(144.81), stepHz: 5_000, mode: 'APRS' },
  { name: 'Air band, 118-137 MHz', startHz: mhz(118), stopHz: mhz(137), stepHz: 25_000, mode: 'AM' },
  { name: 'FM broadcast, 88-108 MHz', startHz: mhz(88), stopHz: mhz(108), stepHz: 100_000, mode: 'WFM' },
  { name: 'Marine VHF, 156-162 MHz', startHz: mhz(156), stopHz: mhz(162), stepHz: 25_000, mode: 'NFM' },
  { name: 'NOAA weather, 162.4-162.55 MHz', startHz: mhz(162.4), stopHz: mhz(162.55), stepHz: 25_000, mode: 'NFM' },
  { name: 'FRS / GMRS, 462.5-467.7 MHz', startHz: mhz(462.5), stopHz: mhz(467.7), stepHz: 12_500, mode: 'NFM' },
  { name: 'CB, 26.965-27.405 MHz', startHz: mhz(26.965), stopHz: mhz(27.405), stepHz: 10_000, mode: 'AM' },
  { name: '40 m phone, 7.125-7.3 MHz', startHz: mhz(7.125), stopHz: mhz(7.3), stepHz: 1_000, mode: 'LSB' },
  { name: '20 m phone, 14.15-14.35 MHz', startHz: mhz(14.15), stopHz: mhz(14.35), stepHz: 1_000, mode: 'USB' },
  { name: '20 m CW, 14.0-14.07 MHz', startHz: mhz(14), stopHz: mhz(14.07), stepHz: 100, mode: 'CW' },
];

/** Maps one slice's bins onto the band's display columns, strongest bin winning. */
export function spectrumToColumns(
  columns: Float32Array,
  band: { startHz: number; stopHz: number },
  sliceStartHz: number,
  binHz: number,
  db: Float32Array,
) {
  const n = columns.length;
  const hzPerColumn = (band.stopHz - band.startHz) / n;
  const firstColumn = Math.max(0, Math.floor((sliceStartHz - band.startHz) / hzPerColumn));
  const lastColumn = Math.min(n - 1, Math.ceil((sliceStartHz + db.length * binHz - band.startHz) / hzPerColumn) - 1);

  for (let col = firstColumn; col <= lastColumn; col++) {
    const colStart = band.startHz + col * hzPerColumn;
    const firstBin = Math.floor((colStart - sliceStartHz) / binHz);
    const lastBin = Math.ceil((colStart + hzPerColumn - sliceStartHz) / binHz) - 1;
    let peak = -Infinity;
    for (let b = Math.max(0, firstBin); b <= Math.min(db.length - 1, lastBin); b++) {
      if (db[b] > peak) peak = db[b];
    }
    if (peak > -Infinity) columns[col] = peak;
  }
}
