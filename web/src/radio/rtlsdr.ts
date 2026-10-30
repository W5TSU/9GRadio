import type { RadioDriver, RadioInfo } from './types';
import { Serial, UsbStream } from './usbStream';

/**
 * RTL2832U with an R820T, R820T2 or R828D tuner. Ported from the Android app's
 * RtlSdrDevice.kt, itself a port of librtlsdr and tuner_r82xx.c. Register values
 * and write order deliberately follow that code.
 */

const BLOCK_USB = 1;
const BLOCK_SYS = 2;
const REG_DEMOD_CTL = 0x3000;
const REG_GPO = 0x3001;
const REG_GPOE = 0x3003;
const REG_GPD = 0x3004;
const REG_DEMOD_CTL_1 = 0x300b;
const USB_SYSCTL = 0x2000;
const USB_EPA_CTL = 0x2148;
const USB_EPA_MAXPKT = 0x2158;
const IIC_READ = 0x0600;
const IIC_WRITE = 0x0610;

const R828D_ADDR = 0x74;
const R820T_ADDR = 0x34;
const R82XX_CHIP_ID = 0x69;
const UPCONVERTER_GPIO = 5;
const BIAS_TEE_GPIO = 0;

const XTAL_HZ = 28_800_000;
const IF_HZ = 3_570_000;
const HF_CUTOFF_HZ = 28_800_000;
const VHF_UHF_BOUNDARY_HZ = 250_000_000;
const R828D_BAND_BOUNDARY_HZ = 345_000_000;

const SAMPLE_RATE = 2_400_000;
const MIN_HZ = 24_000_000;
const MIN_HZ_V4 = 500_000;
const MAX_HZ = 1_766_000_000;
const TRANSFER_BYTES = 32_768;
const QUEUE_DEPTH = 6;
const DEFAULT_GAIN_DB = 33.8;

/** Tenths of a dB. From tuner_r82xx.c. */
const GAIN_TABLE = [0, 9, 14, 27, 37, 77, 87, 125, 144, 157, 166, 197, 207, 229, 254, 280, 297, 328, 338, 364, 372, 386, 402, 421, 434, 439, 445, 480, 496];
const LNA_STEPS = [0, 9, 13, 40, 38, 13, 31, 22, 26, 31, 26, 14, 19, 5, 35, 13];
const MIX_STEPS = [0, 5, 10, 10, 19, 9, 10, 25, 17, 10, 8, 16, 13, 6, 3, -8];

/** Tracking filter and RF mux settings: [start MHz, open drain, rf mux, tracking filter]. */
const FREQ_RANGES: [number, number, number, number][] = [
  [0, 0x08, 0x02, 0xdf],
  [50, 0x08, 0x02, 0xbe],
  [55, 0x08, 0x02, 0x8b],
  [60, 0x08, 0x02, 0x7b],
  [65, 0x08, 0x02, 0x69],
  [70, 0x08, 0x02, 0x58],
  [75, 0x00, 0x02, 0x44],
  [80, 0x00, 0x02, 0x44],
  [90, 0x00, 0x02, 0x34],
  [100, 0x00, 0x02, 0x34],
  [110, 0x00, 0x02, 0x24],
  [120, 0x00, 0x02, 0x24],
  [140, 0x00, 0x02, 0x14],
  [180, 0x00, 0x02, 0x13],
  [220, 0x00, 0x02, 0x13],
  [250, 0x00, 0x02, 0x11],
  [280, 0x00, 0x02, 0x00],
  [310, 0x00, 0x41, 0x00],
  [450, 0x00, 0x41, 0x00],
  [588, 0x00, 0x40, 0x00],
  [650, 0x00, 0x40, 0x00],
];

/** Registers 0x05 to 0x1F. */
const R82XX_INIT = [
  0x83, 0x30, 0x75, 0xc0, 0x40, 0xd6, 0x6c, 0xf5, 0x63, 0x75, 0x68, 0x6c, 0x83, 0x80, 0x00, 0x0f, 0x00, 0xc0, 0x30, 0x48,
  0xcc, 0x60, 0x00, 0x54, 0xae, 0x4a, 0xc0,
];

const BITREV_NIBBLE = [0x0, 0x8, 0x4, 0xc, 0x2, 0xa, 0x6, 0xe, 0x1, 0x9, 0x5, 0xd, 0x3, 0xb, 0x7, 0xf];
const bitrev = (b: number) => (BITREV_NIBBLE[b & 0xf] << 4) | BITREV_NIBBLE[b >> 4];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Tuner = 'R820T' | 'R828D';
type Band = 'unknown' | 'hf' | 'vhf' | 'uhf';

export class RtlSdr implements RadioDriver {
  info: RadioInfo;
  private readonly stream: UsbStream;
  private readonly serial = new Serial();
  private readonly shadow = new Uint8Array(R82XX_INIT.length);
  private tuner: Tuner = 'R820T';
  private isV4 = false;
  private tunerXtal = XTAL_HZ;
  private band: Band = 'unknown';
  private ppm = 0;
  private gainIndex = 0;

  constructor(private readonly device: USBDevice) {
    this.info = {
      kind: 'rtlsdr',
      name: device.productName || 'RTL-SDR',
      serial: device.serialNumber ?? undefined,
      minHz: MIN_HZ,
      maxHz: MAX_HZ,
      sampleRate: SAMPLE_RATE,
      maxGainDb: 49.6,
      defaultGainDb: DEFAULT_GAIN_DB,
    };
    this.stream = new UsbStream(device, TRANSFER_BYTES, QUEUE_DEPTH, (raw, out) => {
      const s = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      for (let i = 0; i < s.length; i++) out[i] = (s[i] - 127.5) / 127.5;
    });
  }

  get latencySamples() {
    return this.stream.latencySamples;
  }

  async open() {
    const d = this.device;
    await d.open();
    if (d.configuration?.configurationValue !== 1) await d.selectConfiguration(1);
    await d.claimInterface(0);

    await this.writeReg(BLOCK_USB, USB_SYSCTL, 0x09, 1);
    await sleep(10);
    await this.initBaseband();

    this.tuner = await this.detectTuner();
    const named = /RTLSDRBlog/i.test(d.manufacturerName ?? '') || /Blog V4/i.test(d.productName ?? '');
    this.isV4 = this.tuner === 'R828D' && (named || (d.vendorId === 0x0bda && d.productId === 0x2838));
    if (this.tuner === 'R828D' && !this.isV4) this.tunerXtal = 16_000_000;

    this.info = {
      ...this.info,
      tuner: this.tuner,
      isV4: this.isV4,
      name: this.isV4 ? 'RTL-SDR Blog V4' : this.info.name,
      minHz: this.isV4 ? MIN_HZ_V4 : MIN_HZ,
    };

    // Disable Zero-IF, in-phase ADC only, set the IF, enable spectrum inversion.
    await this.writeDemod(1, 0xb1, 0x1a, 1);
    await this.writeDemod(0, 0x08, 0x4d, 1);
    await this.setIfFreq();
    await this.writeDemod(1, 0x15, 0x01, 1);

    await this.r82xxInit();
    await this.setSampleRateRegs();
    await this.setBiasTeeOff();

    // Manual gain: the AGCs would move the noise floor the scanner measures against.
    await this.writeDemod(0, 0x19, 0x05, 1);
    await this.withBridge(async () => {
      await this.writeMask(0x05, 0x10, 0x10);
      await this.writeMask(0x07, 0x00, 0x10);
    });
    await this.applyGain();
  }

  setFrequency(hz: number) {
    return this.serial.run(() => this.tune(hz));
  }

  setGainDb(db: number) {
    return this.serial.run(async () => {
      let best = 0;
      for (let i = 0; i < GAIN_TABLE.length; i++) {
        if (Math.abs(GAIN_TABLE[i] / 10 - db) < Math.abs(GAIN_TABLE[best] / 10 - db)) best = i;
      }
      this.gainIndex = best;
      await this.applyGain();
    });
  }

  setPpm(ppm: number) {
    return this.serial.run(async () => {
      this.ppm = ppm;
      await this.writePpmRegs();
    });
  }

  async start(onIq: (iq: Float32Array) => void, onError: (error: Error) => void) {
    await this.serial.run(async () => {
      await this.writeReg(BLOCK_USB, USB_EPA_CTL, 0x1002, 2);
      await this.writeReg(BLOCK_USB, USB_EPA_CTL, 0x0000, 2);
    });
    this.stream.start(onIq, onError);
  }

  async stop() {
    await this.stream.stop();
  }

  async close() {
    await this.device.close();
  }

  private async initBaseband() {
    await this.writeReg(BLOCK_USB, USB_SYSCTL, 0x09, 1);
    await this.writeReg(BLOCK_USB, USB_EPA_MAXPKT, 0x0200, 2);
    await this.writeReg(BLOCK_USB, USB_EPA_CTL, 0x1002, 2);

    await this.writeReg(BLOCK_SYS, REG_DEMOD_CTL_1, 0x22, 1);
    await this.writeReg(BLOCK_SYS, REG_DEMOD_CTL, 0xe8, 1);

    await this.writeDemod(1, 0x01, 0x14, 1);
    await this.writeDemod(1, 0x01, 0x10, 1);
    await this.writeDemod(1, 0x15, 0x00, 1);
    await this.writeDemod(1, 0x16, 0x0000, 2);
    for (let i = 0; i < 6; i++) await this.writeDemod(1, 0x16 + i, 0x00, 1);

    await this.setFir();

    await this.writeDemod(0, 0x19, 0x05, 1);
    await this.writeDemod(1, 0x93, 0xf0, 1);
    await this.writeDemod(1, 0x94, 0x0f, 1);
    await this.writeDemod(1, 0x11, 0x00, 1);
    await this.writeDemod(1, 0x04, 0x00, 1);
    await this.writeDemod(0, 0x61, 0x60, 1);
    await this.writeDemod(0, 0x06, 0x80, 1);
    await this.writeDemod(1, 0xb1, 0x1b, 1);
    await this.writeDemod(0, 0x0d, 0x83, 1);
  }

  private async setFir() {
    const taps = [-54, -36, -41, -40, -32, -14, 14, 53, 101, 156, 215, 273, 327, 372, 404, 421];
    const fir = new Uint8Array(20);
    for (let i = 0; i < 8; i++) fir[i] = taps[i] & 0xff;
    for (let i = 0; i < 8; i += 2) {
      const v0 = taps[8 + i];
      const v1 = taps[8 + i + 1];
      const at = 8 + (i * 3) / 2;
      fir[at] = (v0 >> 4) & 0xff;
      fir[at + 1] = ((v0 << 4) | ((v1 >> 8) & 0x0f)) & 0xff;
      fir[at + 2] = v1 & 0xff;
    }
    for (let i = 0; i < fir.length; i++) await this.writeDemod(1, 0x1c + i, fir[i], 1);
  }

  private async detectTuner(): Promise<Tuner> {
    await this.setBridge(true);
    try {
      if ((await this.i2cRead(0xc8, 0x02)) === 0x40) throw new Error('This dongle has an E4000 tuner, which the web version does not support yet.');
      if ((await this.i2cRead(0xc6, 0x00)) === 0xa3) throw new Error('This dongle has an FC0013 tuner, which the web version does not support yet.');
      if ((await this.i2cRead(R820T_ADDR, 0x00)) === R82XX_CHIP_ID) return 'R820T';
      if ((await this.i2cRead(R828D_ADDR, 0x00)) === R82XX_CHIP_ID) return 'R828D';
      await this.setGpioOutput(4);
      await this.setGpio(4, true);
      await this.setGpio(4, false);
      if (((await this.i2cRead(0xac, 0x01)) & 0x7f) === 0x56) throw new Error('This dongle has an FC2580 tuner, which the web version does not support yet.');
      if ((await this.i2cRead(0xc6, 0x00)) === 0xa1) throw new Error('This dongle has an FC0012 tuner, which the web version does not support yet.');
      throw new Error('No supported tuner answered. Try unplugging the dongle and plugging it back in.');
    } finally {
      await this.setBridge(false);
    }
  }

  private async r82xxInit() {
    await this.withBridge(async () => {
      this.shadow.set(R82XX_INIT);
      await this.writeBurst(0x05, R82XX_INIT);
      this.band = 'unknown';
      await this.setTvStandard();
      await this.sysfreqSel();
    });
  }

  /** Filter calibration and the SDR-mode filter setup. */
  private async setTvStandard() {
    const hpCor = 0x6b;
    await this.writeMask(0x0c, 0x00, 0x0f);
    await this.writeMask(0x13, 49, 0x3f);
    await this.writeMask(0x1d, 0x00, 0x38);

    let calCode = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.writeMask(0x0b, hpCor, 0x60);
      await this.writeMask(0x0f, 0x04, 0x04);
      await this.writeMask(0x10, 0x00, 0x03);
      await this.setPll(56_000_000);
      await this.writeMask(0x0b, 0x10, 0x10);
      await this.writeMask(0x0b, 0x00, 0x10);
      await this.writeMask(0x0f, 0x00, 0x04);
      const status = await this.read(0x00, 5);
      calCode = status[4] & 0x0f;
      if (calCode !== 0 && calCode !== 0x0f) break;
    }
    if (calCode === 0x0f) calCode = 0;

    await this.writeMask(0x0a, 0x10 | calCode, 0x1f);
    await this.writeMask(0x0b, hpCor, 0xef);
    await this.writeMask(0x07, 0x00, 0x80);
    await this.writeMask(0x06, 0x30, 0x30);
    await this.writeMask(0x1e, 0x60, 0x60);
    await this.writeMask(0x05, 0x80, 0x80);
    await this.writeMask(0x1f, 0x00, 0x80);
    await this.writeMask(0x0f, 0x00, 0x80);
    await this.writeMask(0x19, 0x60, 0x60);
  }

  private async sysfreqSel() {
    const mixerTop = 0x24;
    await this.writeMask(0x1d, 0xe5, 0xc7);
    await this.writeMask(0x1c, mixerTop, 0xf8);
    await this.write(0x0d, 0x53);
    await this.write(0x0e, 0x75);
    await this.writeMask(0x05, 0x00, 0x60);
    await this.writeMask(0x06, 0x00, 0x08);
    await this.writeMask(0x11, 0x38, 0x38);
    await this.writeMask(0x17, 0xa0, 0x30);
    await this.writeMask(0x0a, 0x40, 0x60);
    await this.writeMask(0x1d, 0, 0x38);
    await this.writeMask(0x1c, 0, 0x04);
    await this.writeMask(0x06, 0, 0x40);
    await this.writeMask(0x1a, 0x30, 0x30);
    await this.writeMask(0x1d, 0x18, 0x38);
    await this.writeMask(0x1c, mixerTop, 0x04);
    await this.writeMask(0x1e, 14, 0x1f);
    await this.writeMask(0x1a, 0x20, 0x30);
  }

  private async setPll(freqHz: number): Promise<boolean> {
    const freqKhz = Math.floor((freqHz + 500) / 1000);
    const pllRef = this.tunerXtal;

    await this.writeMask(0x10, 0, 0x10);
    await this.writeMask(0x1a, 0x00, 0x0c);
    await this.writeMask(0x12, 0x06, 0xff);

    const vcoMin = 1_770_000;
    const vcoMax = vcoMin * 2;
    let mixDiv = 2;
    let divNum = 0;
    while (mixDiv <= 64) {
      if (freqKhz * mixDiv >= vcoMin && freqKhz * mixDiv < vcoMax) {
        for (let b = mixDiv; b > 2; b >>= 1) divNum++;
        break;
      }
      mixDiv <<= 1;
    }

    const status = await this.read(0x00, 5);
    const vcoPowerRef = this.tuner === 'R828D' ? 1 : 2;
    const fineTune = (status[4] & 0x30) >> 4;
    if (fineTune > vcoPowerRef) divNum--;
    else if (fineTune < vcoPowerRef) divNum++;
    await this.writeMask(0x10, divNum << 5, 0xe0);

    const vcoHz = freqHz * mixDiv;
    const nint = Math.floor(vcoHz / (2 * pllRef));
    const vcoFra = vcoHz - 2 * pllRef * nint;
    if (nint > 128 / vcoPowerRef - 1) {
      console.warn(`R82xx: no valid PLL values for ${freqHz} Hz`);
      return false;
    }

    const ni = Math.floor((nint - 13) / 4);
    const si = nint - 4 * ni - 13;
    await this.write(0x14, ni + (si << 6));
    await this.writeMask(0x12, vcoFra === 0 ? 0x08 : 0x00, 0x08);

    let nSdm = 2;
    let sdm = 0;
    let fra = vcoFra;
    while (fra > 1) {
      const step = Math.trunc((2 * pllRef) / nSdm);
      if (fra > step) {
        sdm += Math.trunc(32768 / (nSdm / 2));
        fra -= step;
        if (nSdm >= 0x8000) break;
      }
      nSdm *= 2;
    }
    await this.write(0x16, sdm >> 8);
    await this.write(0x15, sdm & 0xff);

    await sleep(5);
    let locked = false;
    for (let attempt = 0; attempt < 2 && !locked; attempt++) {
      const lock = await this.read(0x00, 3);
      locked = (lock[2] & 0x40) !== 0;
      if (!locked && attempt === 0) await this.writeMask(0x12, 0x06, 0xff);
    }
    if (locked) await this.writeMask(0x1a, 0x08, 0x08);
    else console.warn(`R82xx: PLL not locked for ${freqHz} Hz`);
    return locked;
  }

  private async setMux(loHz: number) {
    const mhz = Math.floor(loHz / 1_000_000);
    let index = FREQ_RANGES.length - 1;
    for (let i = 0; i < FREQ_RANGES.length - 1; i++) {
      if (mhz < FREQ_RANGES[i + 1][0]) {
        index = i;
        break;
      }
    }
    const [, openD, rfMux, tfC] = FREQ_RANGES[index];
    await this.writeMask(0x17, openD, 0x08);
    await this.writeMask(0x1a, rfMux, 0xc3);
    await this.write(0x1b, tfC);
    await this.writeMask(0x10, 0x00, 0x0b);
    await this.writeMask(0x08, 0x00, 0x3f);
    await this.writeMask(0x09, 0x00, 0x3f);
  }

  private async tune(hz: number) {
    const req = Math.round(hz + (hz * this.ppm) / 1e6);
    await this.withBridge(async () => {
      const rf = this.isV4 && req < HF_CUTOFF_HZ ? req + XTAL_HZ : req;
      const lo = rf + IF_HZ;
      await this.setMux(lo);
      await this.writeMask(0x0c, 0x08, 0x9f);
      await this.setPll(lo);

      if (this.isV4) {
        const inNotchBand =
          req <= 2_200_000 || (req >= 85_000_000 && req <= 112_000_000) || (req >= 172_000_000 && req <= 242_000_000);
        await this.writeMask(0x17, inNotchBand ? 0x00 : 0x08, 0x08);

        const band: Band = req <= HF_CUTOFF_HZ ? 'hf' : req < VHF_UHF_BOUNDARY_HZ ? 'vhf' : 'uhf';
        if (band === 'hf') {
          await this.writeMask(0x1a, 0x40, 0xc3);
          await this.write(0x1b, 0x00);
        }
        if (band !== this.band) {
          this.band = band;
          await this.writeMask(0x06, band === 'hf' ? 0x08 : 0x00, 0x08);
          await this.setGpioOutput(UPCONVERTER_GPIO);
          await this.setGpio(UPCONVERTER_GPIO, band !== 'hf');
          await this.writeMask(0x05, band === 'vhf' ? 0x40 : 0x00, 0x40);
          await this.writeMask(0x05, band === 'uhf' ? 0x00 : 0x20, 0x20);
        }
      } else if (this.tuner === 'R828D') {
        await this.writeMask(0x05, req > R828D_BAND_BOUNDARY_HZ ? 0x00 : 0x60, 0x60);
      }

      await this.writeMask(0x0a, 0x00, 0x10);
      await this.writeMask(0x0b, 0x80, 0xef);
    });
    await this.setIfFreq();
  }

  private async setSampleRateRegs() {
    const ratio = Math.floor((XTAL_HZ * 2 ** 22) / SAMPLE_RATE) & 0x0ffffffc;
    await this.writeDemod(1, 0x9f, (ratio >>> 16) & 0xffff, 2);
    await this.writeDemod(1, 0xa1, ratio & 0xffff, 2);
    await this.withBridge(async () => {
      await this.writeMask(0x0a, 0x00, 0x10);
      await this.writeMask(0x0b, 0x80, 0xef);
    });
    await this.writePpmRegs();
    await this.writeDemod(1, 0x01, 0x14, 1);
    await this.writeDemod(1, 0x01, 0x10, 1);
  }

  private async writePpmRegs() {
    const offs = (Math.round((-this.ppm * 2 ** 22) / 1e6) << 16) >> 16;
    await this.writeDemod(1, 0x3f, offs & 0xff, 1);
    await this.writeDemod(1, 0x3e, (offs >>> 8) & 0x3f, 1);
  }

  private async setIfFreq() {
    const ifFreq = -Math.trunc((IF_HZ * 2 ** 22) / XTAL_HZ);
    await this.writeDemod(1, 0x19, (ifFreq >> 16) & 0x3f, 1);
    await this.writeDemod(1, 0x1a, (ifFreq >> 8) & 0xff, 1);
    await this.writeDemod(1, 0x1b, ifFreq & 0xff, 1);
  }

  private async applyGain() {
    const target = GAIN_TABLE[this.gainIndex];
    await this.withBridge(async () => {
      await this.writeMask(0x05, 0x10, 0x10);
      await this.writeMask(0x07, 0x00, 0x10);
      let lna = 0;
      let mix = 0;
      let total = 0;
      for (let i = 0; i < 15; i++) {
        if (total >= target) break;
        total += LNA_STEPS[++lna];
        if (total >= target) break;
        total += MIX_STEPS[++mix];
      }
      await this.writeMask(0x05, lna, 0x0f);
      await this.writeMask(0x07, mix, 0x0f);
      await this.writeMask(0x0c, 0x08, 0x9f);
    });
  }

  private async setBiasTeeOff() {
    await this.setGpioOutput(BIAS_TEE_GPIO);
    await this.setGpio(BIAS_TEE_GPIO, false);
  }

  private async withBridge(work: () => Promise<void>) {
    await this.setBridge(true);
    try {
      await work();
    } finally {
      await this.setBridge(false);
    }
  }

  private setBridge(open: boolean) {
    return this.writeDemod(1, 0x01, open ? 0x18 : 0x10, 1);
  }

  private async setGpioOutput(pin: number) {
    const mask = 1 << pin;
    const gpd = await this.readReg(BLOCK_SYS, REG_GPD);
    await this.writeReg(BLOCK_SYS, REG_GPD, gpd & ~mask & 0xff, 1);
    const gpoe = await this.readReg(BLOCK_SYS, REG_GPOE);
    await this.writeReg(BLOCK_SYS, REG_GPOE, (gpoe | mask) & 0xff, 1);
  }

  private async setGpio(pin: number, high: boolean) {
    const mask = 1 << pin;
    const gpo = await this.readReg(BLOCK_SYS, REG_GPO);
    await this.writeReg(BLOCK_SYS, REG_GPO, (high ? gpo | mask : gpo & ~mask) & 0xff, 1);
  }

  // ── Tuner registers, through the RTL2832U's I2C bridge ─────────────────────

  private tunerAddr() {
    return this.tuner === 'R828D' ? R828D_ADDR : R820T_ADDR;
  }

  private async write(reg: number, value: number) {
    const v = value & 0xff;
    if (reg >= 0x05 && reg - 0x05 < this.shadow.length) this.shadow[reg - 0x05] = v;
    await this.ctrlOut(this.tunerAddr(), IIC_WRITE, Uint8Array.of(reg, v));
  }

  private async writeMask(reg: number, value: number, mask: number) {
    const current = this.shadow[reg - 0x05];
    await this.write(reg, (current & ~mask) | (value & mask));
  }

  private async writeBurst(start: number, values: number[]) {
    const maxPayload = 7;
    for (let at = 0; at < values.length; at += maxPayload) {
      const chunk = values.slice(at, at + maxPayload);
      await this.ctrlOut(this.tunerAddr(), IIC_WRITE, Uint8Array.of(start + at, ...chunk));
    }
  }

  private async read(reg: number, length: number): Promise<number[]> {
    await this.ctrlOut(this.tunerAddr(), IIC_WRITE, Uint8Array.of(reg));
    const data = await this.ctrlIn(this.tunerAddr(), IIC_READ, length);
    return [...data].map(bitrev);
  }

  private async i2cRead(addr: number, reg: number): Promise<number> {
    await this.ctrlOut(addr, IIC_WRITE, Uint8Array.of(reg));
    return (await this.ctrlIn(addr, IIC_READ, 1))[0];
  }

  // ── RTL2832U registers ─────────────────────────────────────────────────────

  private async writeReg(block: number, addr: number, value: number, length: 1 | 2) {
    const data = length === 1 ? Uint8Array.of(value & 0xff) : Uint8Array.of(value & 0xff, (value >> 8) & 0xff);
    await this.ctrlOut(addr, (block << 8) | 0x10, data);
  }

  private async readReg(block: number, addr: number): Promise<number> {
    return (await this.ctrlIn(addr, block << 8, 1))[0];
  }

  private async writeDemod(page: number, addr: number, value: number, length: 1 | 2) {
    const data = length === 1 ? Uint8Array.of(value & 0xff) : Uint8Array.of((value >> 8) & 0xff, value & 0xff);
    await this.ctrlOut((addr << 8) | 0x20, 0x10 | page, data);
    // The chip needs a read after each demod write.
    await this.ctrlIn((0x01 << 8) | 0x20, 0x0a, 1);
  }

  private async ctrlOut(value: number, index: number, data: BufferSource) {
    const r = await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0, value, index }, data);
    if (r.status !== 'ok') throw new Error(`RTL-SDR write failed: ${r.status}`);
  }

  private async ctrlIn(value: number, index: number, length: number): Promise<Uint8Array> {
    const r = await this.device.controlTransferIn({ requestType: 'vendor', recipient: 'device', request: 0, value, index }, length);
    if (r.status !== 'ok' || !r.data) throw new Error(`RTL-SDR read failed: ${r.status}`);
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  }
}
