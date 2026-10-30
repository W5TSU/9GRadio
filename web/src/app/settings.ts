import type { Mode } from '../dsp/demod';
import type { RadioInfo } from '../radio/types';
import { BAND_PRESETS } from '../ui/format';

export interface RadioSettings {
  startHz: number;
  stopHz: number;
  stepHz: number;
  mode: Mode;
  marginDb: number;
  minStayS: number;
  delayS: number;
  gainDb: number;
  ppm: number;
}

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;

export function defaultSettings(info: Pick<RadioInfo, 'defaultGainDb'>): RadioSettings {
  const { startHz, stopHz, stepHz, mode } = BAND_PRESETS[0];
  return { startHz, stopHz, stepHz, mode, marginDb: 12, minStayS: 10, delayS: 3, gainDb: info.defaultGainDb, ppm: 0 };
}

export function loadSettings(store: KeyValueStore, key: string, defaults: RadioSettings): RadioSettings {
  try {
    const saved = store.getItem(key);
    return saved ? { ...defaults, ...(JSON.parse(saved) as Partial<RadioSettings>) } : defaults;
  } catch {
    return defaults;
  }
}

export function saveSettings(store: KeyValueStore, key: string, settings: RadioSettings) {
  store.setItem(key, JSON.stringify(settings));
}
