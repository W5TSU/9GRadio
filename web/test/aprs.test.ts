import { describe, expect, it } from 'vitest';
import { crc16, parseFrame } from '../src/decoders/ax25';
import { parseAprs, type Ax25Addressing } from '../src/decoders/aprs';

const ax: Ax25Addressing = { source: 'KE5ABC-9', destination: 'APDR16', path: ['N5DIG-1*', 'WIDE2-1'] };
const parse = (info: string, over: Partial<Ax25Addressing> = {}) => parseAprs({ ...ax, ...over, info });

describe('crc16', () => {
  it('matches the published CRC-16/X-25 check value', () => {
    const bytes = new TextEncoder().encode('123456789');
    expect(crc16(bytes, bytes.length)).toBe(0x906e);
  });
});

describe('parseFrame', () => {
  const dest = [0x82, 0xa0, 0xa4, 0xa6, 0x40, 0x40, 0x60]; // APRS
  const src = [0x9c, 0x60, 0x86, 0x82, 0x98, 0x98, 0x72]; // N0CALL-9, more addresses follow
  const digi = [0x9c, 0x6a, 0x88, 0x92, 0x8e, 0x40, 0xe3]; // N5DIG-1, repeated, last address
  const srcLast = [0x9c, 0x60, 0x86, 0x82, 0x98, 0x98, 0x73];
  const tail = [0x03, 0xf0, 0x3e, 0x68, 0x69]; // UI, no layer 3, ">hi"

  const withFcs = (bytes: number[]) => {
    const u = Uint8Array.from(bytes);
    const fcs = crc16(u, u.length);
    return Uint8Array.from([...bytes, fcs & 0xff, fcs >> 8]);
  };

  it('reads source, destination and info with no digipeaters', () => {
    expect(parseFrame(withFcs([...dest, ...srcLast, ...tail]))).toEqual({
      source: 'N0CALL-9',
      destination: 'APRS',
      path: [],
      info: '>hi',
    });
  });

  it('marks a digipeater that has repeated the packet with a star', () => {
    expect(parseFrame(withFcs([...dest, ...src, ...digi, ...tail]))?.path).toEqual(['N5DIG-1*']);
  });

  it('rejects a frame whose checksum fails', () => {
    const f = withFcs([...dest, ...srcLast, ...tail]);
    f[20] ^= 0x01;
    expect(parseFrame(f)).toBeNull();
  });

  it('rejects a valid frame that is not a UI frame', () => {
    expect(parseFrame(withFcs([...dest, ...srcLast, 0x11, 0xf0, 0x3e]))).toBeNull();
  });

  it('rejects a frame shorter than the minimum', () => {
    expect(parseFrame(Uint8Array.from([0x82, 0xa0, 0xa4]))).toBeNull();
  });

  it('rejects a frame whose address field never ends', () => {
    const noEnd = [...dest, ...src, ...src, ...src];
    expect(parseFrame(withFcs(noEnd))).toBeNull();
  });
});

describe('parseAprs', () => {
  it('builds the raw packet text', () => {
    expect(parse('>hello').raw).toBe('KE5ABC-9>APDR16,N5DIG-1*,WIDE2-1:>hello');
  });

  it('decodes an uncompressed position with course, speed and comment', () => {
    const p = parse('=3528.46N/09730.12W>270/042 Mobile, monitoring 146.940');
    expect(p.type).toBe('Position');
    expect(p.latitude).toBeCloseTo(35.474333, 5);
    expect(p.longitude).toBeCloseTo(-97.502, 5);
    expect(p.symbol).toBe('/>');
    expect(p.courseDeg).toBe(270);
    expect(p.speedKnots).toBe(42);
    expect(p.comment).toBe('Mobile, monitoring 146.940');
  });

  it('skips the timestamp on a timestamped position', () => {
    const p = parse('@092345z4903.50N/07201.75W-Test');
    expect(p.type).toBe('Position');
    expect(p.latitude).toBeCloseTo(49.058333, 5);
    expect(p.longitude).toBeCloseTo(-72.029167, 5);
    expect(p.comment).toBe('Test');
  });

  it('reads southern and eastern hemispheres as signed', () => {
    const p = parse('!3351.00S/15112.00E-');
    expect(p.latitude).toBeCloseTo(-33.85, 5);
    expect(p.longitude).toBeCloseTo(151.2, 5);
  });

  it('decodes the compressed position example from the APRS spec', () => {
    const p = parse('=/5L!!<*e7>7P[Comment');
    expect(p.type).toBe('Position');
    expect(p.latitude).toBeCloseTo(49.5, 5);
    expect(p.longitude).toBeCloseTo(-72.75, 5);
    expect(p.symbol).toBe('/>');
    expect(p.courseDeg).toBe(88);
    expect(p.speedKnots).toBeCloseTo(36.2, 1);
    expect(p.comment).toBe('Comment');
  });

  it('decodes the Mic-E example from the APRS spec', () => {
    const p = parse('`(_fn"Oj/', { destination: 'S32U6T' });
    expect(p.type).toBe('Position (Mic-E)');
    expect(p.latitude).toBeCloseTo(33 + 25.64 / 60, 5);
    expect(p.longitude).toBeCloseTo(-(12 + 7.74 / 60), 5);
    expect(p.speedKnots).toBe(20);
    expect(p.courseDeg).toBe(251);
    expect(p.symbol).toBe('/j');
  });

  it('applies the Mic-E 100 degree longitude offset', () => {
    const p = parse('`(_fn"Oj/', { destination: 'S32UPT' });
    expect(p.longitude).toBeCloseTo(-(112 + 7.74 / 60), 5);
  });

  it('ignores a Mic-E packet with a destination that cannot hold a position', () => {
    const p = parse('`(_fn"Oj/', { destination: 'APRS' });
    expect(p.latitude).toBeUndefined();
  });

  it('decodes a status report', () => {
    const p = parse('>Digi N5DIG-1 hilltop');
    expect(p.type).toBe('Status');
    expect(p.comment).toBe('Digi N5DIG-1 hilltop');
  });

  it('decodes a message with its id', () => {
    const p = parse(':KE5ABC-9 :QSL see you{12');
    expect(p.type).toBe('Message');
    expect(p.message).toEqual({ to: 'KE5ABC-9', text: 'QSL see you', id: '12' });
  });

  it('decodes a positionless weather report', () => {
    const p = parse('_10090556c220s004g005t077r000p000P000h50b09900wRSW');
    expect(p.type).toBe('Weather');
    expect(p.weather).toEqual({
      windDirDeg: 220,
      windMph: 4,
      gustMph: 5,
      tempF: 77,
      humidityPct: 50,
      pressureMb: 990,
    });
  });

  it('decodes weather carried in a position report', () => {
    const p = parse('=3528.46N/09730.12W_180/005g008t072r000p000P000h48b10162');
    expect(p.type).toBe('Weather');
    expect(p.latitude).toBeCloseTo(35.474333, 5);
    expect(p.weather).toEqual({
      windDirDeg: 180,
      windMph: 5,
      gustMph: 8,
      tempF: 72,
      humidityPct: 48,
      pressureMb: 1016.2,
    });
  });

  it('reads 100 percent humidity from the h00 code', () => {
    expect(parse('_10090556c220s004g005t077h00b09900').weather?.humidityPct).toBe(100);
  });

  it('leaves out weather fields sent as dots', () => {
    const w = parse('_10090556c...s...g...t077h..b.....').weather;
    expect(w).toEqual({ tempF: 77 });
  });

  it('reads altitude from the comment and removes it', () => {
    const p = parse('=3528.46N/09730.12W>Hello /A=001234 there');
    expect(p.altitudeFt).toBe(1234);
    expect(p.comment).toBe('Hello there');
  });

  it('decodes an object with its name and position', () => {
    const p = parse(';LEADER   *092345z4903.50N/07201.75W>088/036');
    expect(p.type).toBe('Object');
    expect(p.objectName).toBe('LEADER');
    expect(p.latitude).toBeCloseTo(49.058333, 5);
    expect(p.courseDeg).toBe(88);
  });

  it('names a telemetry packet', () => {
    expect(parse('T#005,199,000,255,073,123,01101001').type).toBe('Telemetry');
  });

  it('labels anything else as unknown without throwing', () => {
    expect(parse('xyz').type).toBe('Unknown');
    expect(parse('').type).toBe('Unknown');
  });

  it('survives a truncated position', () => {
    const p = parse('=35');
    expect(p.type).toBe('Position');
    expect(p.latitude).toBeUndefined();
  });

  it('rejects a position with an impossible latitude', () => {
    expect(parse('=9928.46N/09730.12W-').latitude).toBeUndefined();
  });
});
