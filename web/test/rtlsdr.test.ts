import { describe, expect, it } from 'vitest';
import { RtlSdr } from '../src/radio/rtlsdr';
import { FakeUsb, bytes } from './helpers/fakeUsb';

const IIC_READ = 0x0600;
const IIC_WRITE = 0x0610;
const USB_BLOCK_WRITE = 0x0110;
const SYS_BLOCK_WRITE = 0x0210;
const SYS_BLOCK_READ = 0x0200;
const GPO = 0x3001;
const USB_EPA_CTL = 0x2148;

/** A simulated dongle: remembers register writes and answers reads like the chips do. */
class FakeDongle {
  readonly usb: FakeUsb;
  readonly tuner = new Map<number, number>();
  readonly demod = new Map<string, number>();
  readonly sys = new Map<number, number>();
  readonly gpoHistory: number[] = [];
  readonly epaHistory: number[] = [];
  private pointer = 0;

  constructor(
    private readonly tunerAddr: number,
    /** vco_fine_tune as the tuner reports it, before bit reversal. */
    private readonly fineTuneRaw: number,
    usbIds: { productId?: number; manufacturerName?: string; productName?: string } = {},
    private readonly chipReplies: Record<string, number> = {},
  ) {
    this.usb = new FakeUsb({
      vendorId: 0x0bda,
      productId: usbIds.productId ?? 0x2832,
      manufacturerName: usbIds.manufacturerName ?? 'Realtek',
      productName: usbIds.productName ?? 'RTL2832U',
      serialNumber: '00000001',
      onOut: (c) => this.onOut(c.value, c.index, bytes(c.data)),
      inResponse: (c) => this.onIn(c.value, c.index, c.length),
    });
  }

  private onOut(value: number, index: number, data: number[]) {
    if (index === IIC_WRITE) {
      this.pointer = data[0];
      if (value !== this.tunerAddr) return;
      data.slice(1).forEach((b, i) => this.tuner.set(data[0] + i, b));
    } else if (index === SYS_BLOCK_WRITE) {
      this.sys.set(value, data[0]);
      if (value === GPO) this.gpoHistory.push(data[0]);
    } else if (index === USB_BLOCK_WRITE) {
      if (value === USB_EPA_CTL) this.epaHistory.push(data[0] | (data[1] << 8));
    } else if ((index & 0xf0) === 0x10 && (value & 0xff) === 0x20) {
      const word = data.length === 2 ? (data[0] << 8) | data[1] : data[0];
      this.demod.set(`${index & 0x0f}:${value >> 8}`, word);
    }
  }

  private onIn(value: number, index: number, length: number): number[] {
    if (index === IIC_READ) {
      const custom = this.chipReplies[`${value}:${this.pointer}`];
      if (custom !== undefined) return [custom];
      if (value !== this.tunerAddr) return new Array(length).fill(0);
      // Status registers: chip id, PLL locked (bit 1 before reversal), fine tune.
      const status = [0x69, 0x00, 0x02, 0x00, this.fineTuneRaw];
      return status.slice(this.pointer, this.pointer + length);
    }
    if (index === SYS_BLOCK_READ) return [this.sys.get(value) ?? 0];
    return new Array(length).fill(0);
  }

  demodReg(page: number, addr: number) {
    return this.demod.get(`${page}:${addr}`);
  }
}

const R820T = 0x34;
const R828D = 0x74;
const FINE_TUNE_2 = 0x04;
const FINE_TUNE_1 = 0x08;

async function openR820t() {
  const hw = new FakeDongle(R820T, FINE_TUNE_2);
  const radio = new RtlSdr(hw.usb.device());
  await radio.open();
  return { hw, radio };
}

async function openV4() {
  const hw = new FakeDongle(R828D, FINE_TUNE_1, {
    productId: 0x2838,
    manufacturerName: 'RTLSDRBlog',
    productName: 'Blog V4',
  });
  const radio = new RtlSdr(hw.usb.device());
  await radio.open();
  return { hw, radio };
}

describe('RtlSdr: opening', () => {
  it('selects configuration 1 and claims interface 0', async () => {
    const { hw } = await openR820t();
    expect(hw.usb.configuration).toBe(1);
    expect(hw.usb.claimed).toEqual([0]);
  });

  it('identifies an ordinary R820T dongle and its range', async () => {
    const { radio } = await openR820t();
    expect(radio.info).toMatchObject({ kind: 'rtlsdr', tuner: 'R820T', minHz: 24_000_000, maxHz: 1_766_000_000, sampleRate: 2_400_000 });
  });

  it('identifies a Blog V4 and its HF coverage', async () => {
    const { radio } = await openV4();
    expect(radio.info).toMatchObject({ tuner: 'R828D', isV4: true, minHz: 500_000 });
  });

  it('refuses a dongle with a tuner it cannot drive, and says which', async () => {
    const hw = new FakeDongle(R820T, 0, {}, { '200:2': 0x40 });
    await expect(new RtlSdr(hw.usb.device()).open()).rejects.toThrow(/E4000/);
  });

  it('refuses when no tuner answers', async () => {
    const hw = new FakeDongle(0x00, 0);
    await expect(new RtlSdr(hw.usb.device()).open()).rejects.toThrow(/tuner/i);
  });

  it('programs 2.4 MS/s into the demod', async () => {
    const { hw } = await openR820t();
    // 28.8 MHz x 2^22 / 2.4 MHz = 0x03000000.
    expect(hw.demodReg(1, 0x9f)).toBe(0x0300);
    expect(hw.demodReg(1, 0xa1)).toBe(0x0000);
  });

  it('sets the demod to the 3.57 MHz IF with spectrum inversion on', async () => {
    const { hw } = await openR820t();
    // -(3.57 MHz x 2^22 / 28.8 MHz) = -519918 = 0xF81112 in 24 bits.
    expect(hw.demodReg(1, 0x19)).toBe(0x38);
    expect(hw.demodReg(1, 0x1a)).toBe(0x11);
    expect(hw.demodReg(1, 0x1b)).toBe(0x12);
    expect(hw.demodReg(1, 0x15)).toBe(0x01);
  });

  it('leaves the I2C bridge closed', async () => {
    const { hw } = await openR820t();
    expect(hw.demodReg(1, 0x01)).toBe(0x10);
  });

  it('never turns on the bias tee', async () => {
    const { hw, radio } = await openV4();
    await radio.setFrequency(14_200_000);
    await radio.setFrequency(146_000_000);
    for (const gpo of hw.gpoHistory) expect(gpo & 0x01).toBe(0);
  });
});

describe('RtlSdr: tuning', () => {
  it('programs the PLL for 144.39 MHz on an R820T', async () => {
    const { hw, radio } = await openR820t();
    await radio.setFrequency(144_390_000);
    // LO = 147.96 MHz. x16 = 2367.36 MHz VCO, in range. 2367.36 / 57.6 = 41 rem 5.76 MHz.
    expect(hw.tuner.get(0x10)! & 0xe0).toBe(3 << 5); // div_num for /16
    expect(hw.tuner.get(0x14)).toBe(0x07); // ni = 7, si = 0
    // SDM = 0.1 of 65536, by binary weights: 6553 = 0x1999.
    expect(hw.tuner.get(0x16)).toBe(0x19);
    expect(hw.tuner.get(0x15)).toBe(0x99);
    expect(hw.demodReg(1, 0x01)).toBe(0x10);
  });

  it('adjusts the divider from the fine tune reading', async () => {
    const hw = new FakeDongle(R820T, 0x00); // fine tune 0, below the reference of 2
    const radio = new RtlSdr(hw.usb.device());
    await radio.open();
    await radio.setFrequency(144_390_000);
    expect(hw.tuner.get(0x10)! & 0xe0).toBe(4 << 5);
  });

  it('upconverts HF on a V4 and selects the HF input', async () => {
    const { hw, radio } = await openV4();
    await radio.setFrequency(14_200_000);
    // LO = 14.2 + 28.8 + 3.57 = 46.57 MHz. x64 = 2980.48 MHz. /57.6 = 51 rem 42.88 MHz.
    expect(hw.tuner.get(0x14)).toBe(0x89); // ni = 9, si = 2
    expect(hw.tuner.get(0x06)! & 0x08).toBe(0x08);
    expect(hw.sys.get(GPO)! & 0x20).toBe(0);
  });

  it('switches back to the VHF input after HF on a V4', async () => {
    const { hw, radio } = await openV4();
    await radio.setFrequency(14_200_000);
    await radio.setFrequency(146_000_000);
    expect(hw.tuner.get(0x06)! & 0x08).toBe(0);
    expect(hw.tuner.get(0x05)! & 0x40).toBe(0x40);
    expect(hw.sys.get(GPO)! & 0x20).toBe(0x20);
  });

  it('switches to the UHF input on a V4', async () => {
    const { hw, radio } = await openV4();
    await radio.setFrequency(446_000_000);
    expect(hw.tuner.get(0x05)! & 0x60).toBe(0);
  });

  it('does not upconvert on an ordinary R828D, and uses its 16 MHz reference', async () => {
    const hw = new FakeDongle(R828D, FINE_TUNE_1, { productId: 0x2832 });
    const radio = new RtlSdr(hw.usb.device());
    await radio.open();
    expect(radio.info).toMatchObject({ isV4: false, minHz: 24_000_000 });
    await radio.setFrequency(100_000_000);
    // LO = 103.57 MHz. x32 = 3314.24 MHz. With a 16 MHz reference, /32 MHz = 103: ni = 22, si = 2.
    expect(hw.tuner.get(0x14)).toBe(0x96);
    // Below 345 MHz this tuner uses its cable input, and there is no upconverter to switch.
    expect(hw.tuner.get(0x05)! & 0x60).toBe(0x60);
    for (const gpo of hw.gpoHistory) expect(gpo & 0x20).toBe(0);
  });

  it('applies a ppm correction to the frequency and the sample clock', async () => {
    const { hw, radio } = await openR820t();
    await radio.setPpm(10);
    // -10 x 2^22 / 1e6 rounds to -42 = 0xFFD6.
    expect(hw.demodReg(1, 0x3f)).toBe(0xd6);
    expect(hw.demodReg(1, 0x3e)).toBe(0x3f);
    await radio.setFrequency(144_390_000);
    // 144.39 MHz + 10 ppm = 144.3914439 MHz, so the SDM word moves from 0x1999.
    expect((hw.tuner.get(0x16)! << 8) | hw.tuner.get(0x15)!).not.toBe(0x1999);
  });

  it('runs concurrent requests one at a time so the I2C bridge is never left open', async () => {
    const { hw, radio } = await openR820t();
    await Promise.all([radio.setFrequency(144_390_000), radio.setGainDb(30), radio.setFrequency(146_520_000)]);
    expect(hw.demodReg(1, 0x01)).toBe(0x10);
    // The later tune wins: 146.52 + 3.57 = 150.09 MHz, x16 = 2401.44, /57.6 = 41 rem 39.84 MHz.
    expect(hw.tuner.get(0x14)).toBe(0x07);
    expect(hw.tuner.get(0x16)).toBe(0xb1);
  });
});

describe('RtlSdr: gain', () => {
  it('splits gain across LNA and mixer as the tuner driver does, in manual mode', async () => {
    const { hw, radio } = await openR820t();
    await radio.setGainDb(33.8);
    // Summing the driver's published steps reaches 33.8 dB at LNA 9, mixer 9.
    expect(hw.tuner.get(0x05)! & 0x0f).toBe(9);
    expect(hw.tuner.get(0x07)! & 0x0f).toBe(9);
    expect(hw.tuner.get(0x05)! & 0x10).toBe(0x10); // LNA auto off
    expect(hw.tuner.get(0x07)! & 0x10).toBe(0); // mixer auto off
    expect(hw.tuner.get(0x0c)! & 0x9f).toBe(0x08); // VGA fixed
  });

  it('picks the nearest gain the tuner has', async () => {
    const { hw, radio } = await openR820t();
    await radio.setGainDb(0.4);
    expect(hw.tuner.get(0x05)! & 0x0f).toBe(0);
    await radio.setGainDb(0.6);
    expect(hw.tuner.get(0x05)! & 0x0f).toBe(1);
  });

  it('runs the demod AGC off so the noise floor stays steady', async () => {
    const { hw } = await openR820t();
    expect(hw.demodReg(0, 0x19)).toBe(0x05);
  });
});

describe('RtlSdr: streaming', () => {
  it('resets the USB endpoint before reading', async () => {
    const { hw, radio } = await openR820t();
    hw.epaHistory.length = 0;
    await radio.start(() => {}, () => {});
    expect(hw.epaHistory).toEqual([0x1002, 0x0000]);
    await radio.stop();
  });

  it('delivers unsigned samples centered and scaled to full scale', async () => {
    const { hw, radio } = await openR820t();
    const blocks: Float32Array[] = [];
    await radio.start((iq) => blocks.push(iq.slice()), () => {});
    hw.usb.deliver([0, 255, 128, 127]);
    await hw.usb.flush();
    expect(blocks[0][0]).toBeCloseTo(-1, 5);
    expect(blocks[0][1]).toBeCloseTo(1, 5);
    expect(blocks[0][2]).toBeCloseTo(0.5 / 127.5, 5);
    expect(blocks[0][3]).toBeCloseTo(-0.5 / 127.5, 5);
    await radio.stop();
  });

  it('reads from endpoint 1 with several transfers queued, and clears them on stop', async () => {
    const { hw, radio } = await openR820t();
    await radio.start(() => {}, () => {});
    expect(hw.usb.endpoints.every((e) => e === 1)).toBe(true);
    expect(hw.usb.inFlight()).toBeGreaterThan(1);
    await radio.stop();
    expect(hw.usb.inFlight()).toBe(0);
  });

  it('reports the samples that may predate a retune', async () => {
    const { hw, radio } = await openR820t();
    await radio.start(() => {}, () => {});
    expect(radio.latencySamples).toBe((hw.usb.inFlight() * hw.usb.lastLength) / 2);
    await radio.stop();
  });

  it('reports a lost connection', async () => {
    const { hw, radio } = await openR820t();
    const errors: Error[] = [];
    await radio.start(() => {}, (e) => errors.push(e));
    hw.usb.failTransfers(new Error('device disconnected'));
    await hw.usb.flush();
    expect(errors[0].message).toMatch(/disconnected/);
  });

  it('closes the device', async () => {
    const { hw, radio } = await openR820t();
    await radio.close();
    expect(hw.usb.opened).toBe(false);
  });
});
