import { describe, expect, it } from 'vitest';
import { HackRf } from '../src/radio/hackrf';
import { FakeUsb, bytes } from './helpers/fakeUsb';

/** Expected values below are taken from libhackrf's hackrf.c. */

const open = async () => {
  const usb = new FakeUsb({ inResponse: () => [1], productId: 0x6089 });
  const radio = new HackRf(usb.device());
  await radio.open();
  return { usb, radio };
};

describe('HackRf', () => {
  it('selects configuration 1 and claims interface 0', async () => {
    const { usb } = await open();
    expect(usb.configuration).toBe(1);
    expect(usb.claimed).toEqual([0]);
  });

  it('sets 4.8 MS/s and the matching filter, as libhackrf does', async () => {
    const { usb } = await open();
    const rate = usb.outs.find((c) => c.request === 6);
    expect(rate).toMatchObject({ value: 0, index: 0 });
    // 4800000 and divider 1, each little-endian.
    expect(bytes(rate!.data)).toEqual([0x00, 0x3e, 0x49, 0x00, 0x01, 0x00, 0x00, 0x00]);
    // 75% of the rate is 3.6 MHz; the largest allowed filter at or below is 3.5 MHz.
    const filter = usb.outs.find((c) => c.request === 7);
    expect(filter).toMatchObject({ value: 3_500_000 & 0xffff, index: 3_500_000 >>> 16 });
  });

  it('tunes with MHz and remaining Hz as two little-endian words', async () => {
    const { usb, radio } = await open();
    usb.outs.length = 0;
    await radio.setFrequency(146_520_000);
    const tune = usb.outs.find((c) => c.request === 16);
    expect(tune).toMatchObject({ value: 0, index: 0 });
    // 146 = 0x92 MHz, 520000 = 0x07EF40 Hz.
    expect(bytes(tune!.data)).toEqual([0x92, 0, 0, 0, 0x40, 0xef, 0x07, 0]);
  });

  it('applies a ppm correction when tuning', async () => {
    const { usb, radio } = await open();
    await radio.setPpm(10);
    usb.outs.length = 0;
    await radio.setFrequency(100_000_000);
    const tune = usb.outs.find((c) => c.request === 16);
    // 100 MHz + 10 ppm = 100.001 MHz.
    expect(bytes(tune!.data)).toEqual([100, 0, 0, 0, 0xe8, 0x03, 0, 0]);
  });

  it('never turns on the RF amp or the antenna power', async () => {
    const { usb, radio } = await open();
    await radio.setGainDb(102);
    await radio.setFrequency(146_520_000);
    await radio.start(() => {}, () => {});
    await radio.stop();
    for (const request of [17, 23]) {
      const enabling = usb.outs.filter((c) => c.request === request && c.value !== 0);
      expect(enabling).toEqual([]);
    }
  });

  it('splits gain across the LNA in 8 dB steps and the VGA in 2 dB steps', async () => {
    const { usb, radio } = await open();
    usb.ins.length = 0;
    await radio.setGainDb(50);
    const lna = usb.ins.find((c) => c.request === 19)!;
    const vga = usb.ins.find((c) => c.request === 20)!;
    expect(lna.index % 8).toBe(0);
    expect(lna.index).toBeLessThanOrEqual(40);
    expect(vga.index % 2).toBe(0);
    expect(vga.index).toBeLessThanOrEqual(62);
    expect(lna.index + vga.index).toBe(50);
    expect(lna.length).toBe(1);
    expect(lna.value).toBe(0);
  });

  it('caps gain at the most the two stages can give', async () => {
    const { usb, radio } = await open();
    usb.ins.length = 0;
    await radio.setGainDb(500);
    expect(usb.ins.find((c) => c.request === 19)!.index).toBe(40);
    expect(usb.ins.find((c) => c.request === 20)!.index).toBe(62);
  });

  it('reports a gain the radio refuses', async () => {
    const usb = new FakeUsb({ inResponse: () => [0], productId: 0x6089 });
    const radio = new HackRf(usb.device());
    await radio.open();
    await expect(radio.setGainDb(20)).rejects.toThrow(/gain/i);
  });

  it('turns receive on, delivers signed samples scaled to full scale, and turns off on stop', async () => {
    const { usb, radio } = await open();
    usb.outs.length = 0;
    const blocks: Float32Array[] = [];
    await radio.start((iq) => blocks.push(iq.slice()), () => {});
    expect(usb.outs.find((c) => c.request === 1)).toMatchObject({ value: 1, index: 0 });

    usb.deliver([-128, 0, 64, 127]);
    await usb.flush();
    expect(blocks[0][0]).toBeCloseTo(-1, 5);
    expect(blocks[0][1]).toBeCloseTo(0, 5);
    expect(blocks[0][2]).toBeCloseTo(0.5, 5);
    expect(blocks[0][3]).toBeCloseTo(127 / 128, 5);

    usb.outs.length = 0;
    await radio.stop();
    expect(usb.outs.find((c) => c.request === 1)).toMatchObject({ value: 0, index: 0 });
    expect(usb.inFlight()).toBe(0);
  });

  it('reads from endpoint 1 and keeps several transfers queued', async () => {
    const { usb, radio } = await open();
    await radio.start(() => {}, () => {});
    expect(usb.endpoints.every((e) => e === 1)).toBe(true);
    expect(usb.inFlight()).toBeGreaterThan(1);
    usb.deliver([0, 0]);
    await usb.flush();
    expect(usb.inFlight()).toBeGreaterThan(1);
    await radio.stop();
  });

  it('does not double the queued reads if started twice', async () => {
    const { usb, radio } = await open();
    await radio.start(() => {}, () => {});
    const queued = usb.inFlight();
    await radio.start(() => {}, () => {});
    expect(usb.inFlight()).toBe(queued);
    await radio.stop();
  });

  it('reports the samples that may predate a retune', async () => {
    const { usb, radio } = await open();
    await radio.start(() => {}, () => {});
    // Two bytes per sample, across everything queued.
    expect(radio.latencySamples).toBe((usb.inFlight() * usb.lastLength) / 2);
    await radio.stop();
  });

  it('reports a lost connection', async () => {
    const { usb, radio } = await open();
    const errors: Error[] = [];
    await radio.start(() => {}, (e) => errors.push(e));
    usb.failTransfers(new Error('device disconnected'));
    await usb.flush();
    expect(errors[0].message).toMatch(/disconnected/);
  });

  it('closes the device', async () => {
    const { usb, radio } = await open();
    await radio.close();
    expect(usb.opened).toBe(false);
  });

  it('describes its range and the sample rate it runs at', async () => {
    const { radio } = await open();
    expect(radio.info).toMatchObject({ kind: 'hackrf', minHz: 1_000_000, maxHz: 6_000_000_000, sampleRate: 4_800_000 });
  });
});
