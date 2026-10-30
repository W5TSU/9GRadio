import { crc16 } from '../decoders/ax25';

/** Builds real APRS transmissions for the demo radio. */

export interface UiFrameFields {
  source: string;
  destination: string;
  path: string[];
  info: string;
}

export function buildUiFrame(f: UiFrameFields): Uint8Array {
  const out: number[] = [];
  const addresses = [f.destination, f.source, ...f.path];
  addresses.forEach((address, i) => {
    const repeated = address.endsWith('*');
    const [call, ssid] = address.replace('*', '').split('-');
    const padded = call.padEnd(6, ' ');
    for (let c = 0; c < 6; c++) out.push(padded.charCodeAt(c) << 1);
    const last = i === addresses.length - 1 ? 0x01 : 0;
    out.push(0x60 | (Number(ssid ?? 0) << 1) | last | (repeated ? 0x80 : 0));
  });
  out.push(0x03, 0xf0);
  for (let i = 0; i < f.info.length; i++) out.push(f.info.charCodeAt(i) & 0xff);
  const bytes = Uint8Array.from(out);
  const fcs = crc16(bytes, bytes.length);
  return Uint8Array.from([...out, fcs & 0xff, fcs >> 8]);
}

export interface AfskOptions {
  amplitude?: number;
  /** Space tone gain relative to mark, as radios with emphasis produce. */
  spaceGain?: number;
  preambleFlags?: number;
  tailFlags?: number;
}

export function afskAudio(frame: Uint8Array, rate: number, o: AfskOptions = {}): Float32Array {
  const { amplitude = 0.7, spaceGain = 1, preambleFlags = 40, tailFlags = 4 } = o;

  const bits: number[] = [];
  const flag = () => {
    for (let b = 0; b < 8; b++) bits.push((0x7e >> b) & 1);
  };
  for (let i = 0; i < preambleFlags; i++) flag();
  let ones = 0;
  for (const byte of frame) {
    for (let b = 0; b < 8; b++) {
      const bit = (byte >> b) & 1;
      bits.push(bit);
      ones = bit ? ones + 1 : 0;
      if (ones === 5) {
        bits.push(0);
        ones = 0;
      }
    }
  }
  for (let i = 0; i < tailFlags; i++) flag();

  const samples = Math.ceil((bits.length * rate) / 1200);
  const audio = new Float32Array(samples);
  let mark = true;
  let phase = 0;
  for (let s = 0; s < samples; s++) {
    const bitIndex = Math.floor((s * 1200) / rate);
    const edge = s === 0 || Math.floor(((s - 1) * 1200) / rate) !== bitIndex;
    if (edge && bits[bitIndex] === 0) mark = !mark;
    phase += (2 * Math.PI * (mark ? 1200 : 2200)) / rate;
    audio[s] = amplitude * (mark ? 1 : spaceGain) * Math.sin(phase);
  }
  return audio;
}
