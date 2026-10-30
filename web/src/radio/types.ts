export interface RadioInfo {
  kind: 'rtlsdr' | 'hackrf' | 'demo';
  name: string;
  serial?: string;
  tuner?: string;
  isV4?: boolean;
  minHz: number;
  maxHz: number;
  sampleRate: number;
  maxGainDb: number;
  defaultGainDb: number;
}

/** One connected radio, however it is reached. */
export interface RadioDriver {
  readonly info: RadioInfo;
  /** Samples still on their way that may predate the most recent retune. */
  readonly latencySamples: number;
  open(): Promise<void>;
  setFrequency(hz: number): Promise<void>;
  setGainDb(db: number): Promise<void>;
  setPpm(ppm: number): Promise<void>;
  /** Interleaved IQ at full scale +/-1. The array is reused after the callback returns. */
  start(onIq: (iq: Float32Array) => void, onError: (error: Error) => void): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export const RTLSDR_FILTERS: USBDeviceFilter[] = [
  { vendorId: 0x0bda, productId: 0x2838 },
  { vendorId: 0x0bda, productId: 0x2832 },
  { vendorId: 0x0bda, productId: 0x2837 },
  { vendorId: 0x0bda, productId: 0x2840 },
  { vendorId: 0x0bda, productId: 0x2836 },
];

export const HACKRF_FILTERS: USBDeviceFilter[] = [
  { vendorId: 0x1d50, productId: 0x6089 },
  { vendorId: 0x1d50, productId: 0x604b },
  { vendorId: 0x1d50, productId: 0xcc15 },
];

export const isHackRf = (d: { vendorId: number }) => d.vendorId === 0x1d50;
