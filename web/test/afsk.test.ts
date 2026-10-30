import { describe, expect, it } from 'vitest';
import { AfskDecoder } from '../src/decoders/afsk';
import { afskAudio, buildUiFrame } from '../src/radio/aprsTx';

const RATE = 48_000;

function seededNoise(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x80000000 - 1;
  };
}

function decode(audio: Float32Array, blockSize = 1024) {
  const out: ReturnType<AfskDecoder['push']> = [];
  const d = new AfskDecoder(RATE);
  for (let i = 0; i < audio.length; i += blockSize) {
    out.push(...d.push(audio.subarray(i, i + blockSize)));
  }
  return out;
}

const frame = (info: string) =>
  buildUiFrame({ source: 'KE5ABC-9', destination: 'APDR16', path: ['WIDE1-1', 'WIDE2-1'], info });

describe('AfskDecoder', () => {
  it('decodes a clean packet', () => {
    const frames = decode(afskAudio(frame('=3528.46N/09730.12W>Hello'), RATE));
    expect(frames).toEqual([
      {
        source: 'KE5ABC-9',
        destination: 'APDR16',
        path: ['WIDE1-1', 'WIDE2-1'],
        info: '=3528.46N/09730.12W>Hello',
      },
    ]);
  });

  it('decodes data that forces bit stuffing', () => {
    const info = '>' + '~'.repeat(30) + '\xff\xff';
    expect(decode(afskAudio(frame(info), RATE))[0]?.info).toBe(info);
  });

  it('decodes when a radio has tilted the tones 6 dB apart', () => {
    const frames = decode(afskAudio(frame('>tilted'), RATE, { spaceGain: 2 }));
    expect(frames[0]?.info).toBe('>tilted');
  });

  it('decodes through noise', () => {
    const audio = afskAudio(frame('>through noise'), RATE, { amplitude: 0.5 });
    const noise = seededNoise(1);
    for (let i = 0; i < audio.length; i++) audio[i] += 0.15 * noise();
    expect(decode(audio)[0]?.info).toBe('>through noise');
  });

  it('decodes two packets in a row', () => {
    const a = afskAudio(frame('>first'), RATE);
    const b = afskAudio(frame('>second'), RATE);
    const both = new Float32Array(a.length + b.length);
    both.set(a);
    both.set(b, a.length);
    expect(decode(both).map((f) => f.info)).toEqual(['>first', '>second']);
  });

  it('gives the same result however the audio is split into blocks', () => {
    const audio = afskAudio(frame('>blocks'), RATE);
    expect(decode(audio, 37)[0]?.info).toBe('>blocks');
    expect(decode(audio, 9973)[0]?.info).toBe('>blocks');
  });

  it('emits nothing for a packet with a damaged middle', () => {
    const audio = afskAudio(frame('>this will be damaged in the middle'), RATE);
    audio.fill(0, audio.length >> 1, (audio.length >> 1) + 400);
    expect(decode(audio)).toEqual([]);
  });

  it('emits nothing from pure noise', () => {
    const noise = seededNoise(42);
    const audio = new Float32Array(RATE * 20);
    for (let i = 0; i < audio.length; i++) audio[i] = noise();
    expect(decode(audio)).toEqual([]);
  });
});
