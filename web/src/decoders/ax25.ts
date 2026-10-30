export interface Ax25Frame {
  source: string;
  destination: string;
  /** Digipeaters in order. A trailing * means that one has repeated the packet. */
  path: string[];
  info: string;
}

const CONTROL_UI = 0x03;
const PID_NO_LAYER3 = 0xf0;
/** Destination, source, control, PID and checksum. */
const MIN_FRAME_BYTES = 18;
const MAX_DIGIPEATERS = 8;

/** AX.25 frame check sequence (CRC-16/X-25). */
export function crc16(data: Uint8Array, length: number): number {
  let crc = 0xffff;
  for (let i = 0; i < length; i++) {
    crc ^= data[i];
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
  }
  return crc ^ 0xffff;
}

/** Returns the frame if its checksum passes and it is a UI frame, the kind APRS uses. */
export function parseFrame(bytes: Uint8Array): Ax25Frame | null {
  const end = bytes.length - 2;
  if (bytes.length < MIN_FRAME_BYTES) return null;
  if (crc16(bytes, end) !== (bytes[end] | (bytes[end + 1] << 8))) return null;

  const path: string[] = [];
  let lastSsid = 13;
  while (!(bytes[lastSsid] & 0x01)) {
    if (path.length === MAX_DIGIPEATERS || lastSsid + 7 >= end) return null;
    const digi = callsign(bytes, lastSsid + 1);
    lastSsid += 7;
    path.push(bytes[lastSsid] & 0x80 ? `${digi}*` : digi);
  }

  const control = lastSsid + 1;
  if (control + 2 >= end) return null;
  if (bytes[control] !== CONTROL_UI || bytes[control + 1] !== PID_NO_LAYER3) return null;

  let info = '';
  for (let i = control + 2; i < end; i++) info += String.fromCharCode(bytes[i]);
  return { source: callsign(bytes, 7), destination: callsign(bytes, 0), path, info };
}

function callsign(frame: Uint8Array, offset: number): string {
  let call = '';
  for (let i = 0; i < 6; i++) {
    const c = frame[offset + i] >> 1;
    if (c !== 0x20) call += String.fromCharCode(c);
  }
  const ssid = (frame[offset + 6] >> 1) & 0x0f;
  return ssid ? `${call}-${ssid}` : call;
}
