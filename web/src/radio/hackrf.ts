import type { RadioDriver, RadioInfo } from './types';
import { Serial, UsbStream } from './usbStream';

// From libhackrf's hackrf.c.
const REQ_SET_TRANSCEIVER_MODE = 1;
const REQ_SAMPLE_RATE_SET = 6;
const REQ_BASEBAND_FILTER_BANDWIDTH_SET = 7;
const REQ_SET_FREQ = 16;
const REQ_SET_LNA_GAIN = 19;
const REQ_SET_VGA_GAIN = 20;
const MODE_OFF = 0;
const MODE_RECEIVE = 1;
const MAX_LNA_DB = 40;
const LNA_STEP_DB = 8;
const MAX_VGA_DB = 62;
const VGA_STEP_DB = 2;

const SAMPLE_RATE = 4_800_000;
/** The largest allowed baseband filter at or below 75% of the sample rate. */
const FILTER_HZ = 3_500_000;
const TRANSFER_BYTES = 65_536;
const QUEUE_DEPTH = 6;

export class HackRf implements RadioDriver {
  readonly info: RadioInfo;
  private readonly stream: UsbStream;
  private readonly serial = new Serial();
  private ppm = 0;

  constructor(private readonly device: USBDevice) {
    this.info = {
      kind: 'hackrf',
      name: device.productName || 'HackRF',
      serial: device.serialNumber ?? undefined,
      minHz: 1_000_000,
      maxHz: 6_000_000_000,
      sampleRate: SAMPLE_RATE,
      maxGainDb: MAX_LNA_DB + MAX_VGA_DB,
      // Measured on a HackRF Pro: 40 dB leaves the samples at quantization level, 84 dB overloads.
      defaultGainDb: 60,
    };
    this.stream = new UsbStream(device, TRANSFER_BYTES, QUEUE_DEPTH, (raw, out) => {
      const s = new Int8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      for (let i = 0; i < s.length; i++) out[i] = s[i] / 128;
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
    const params = new DataView(new ArrayBuffer(8));
    params.setUint32(0, SAMPLE_RATE, true);
    params.setUint32(4, 1, true);
    await this.out(REQ_SAMPLE_RATE_SET, 0, 0, params);
    await this.out(REQ_BASEBAND_FILTER_BANDWIDTH_SET, FILTER_HZ & 0xffff, FILTER_HZ >>> 16);
  }

  setFrequency(hz: number) {
    return this.serial.run(async () => {
      const corrected = Math.round(hz + (hz * this.ppm) / 1e6);
      const mhz = Math.floor(corrected / 1e6);
      const params = new DataView(new ArrayBuffer(8));
      params.setUint32(0, mhz, true);
      params.setUint32(4, corrected - mhz * 1e6, true);
      await this.out(REQ_SET_FREQ, 0, 0, params);
    });
  }

  setGainDb(db: number) {
    return this.serial.run(async () => {
      const total = Math.max(0, Math.min(this.info.maxGainDb, db));
      const lna = Math.min(MAX_LNA_DB, Math.floor((total * MAX_LNA_DB) / this.info.maxGainDb / LNA_STEP_DB) * LNA_STEP_DB);
      const vga = Math.min(MAX_VGA_DB, Math.floor((total - lna) / VGA_STEP_DB) * VGA_STEP_DB);
      await this.setStage(REQ_SET_LNA_GAIN, lna);
      await this.setStage(REQ_SET_VGA_GAIN, vga);
    });
  }

  async setPpm(ppm: number) {
    this.ppm = ppm;
  }

  async start(onIq: (iq: Float32Array) => void, onError: (error: Error) => void) {
    await this.out(REQ_SET_TRANSCEIVER_MODE, MODE_RECEIVE, 0);
    this.stream.start(onIq, onError);
  }

  async stop() {
    await this.out(REQ_SET_TRANSCEIVER_MODE, MODE_OFF, 0);
    await this.stream.stop();
  }

  async close() {
    await this.device.close();
  }

  private async setStage(request: number, value: number) {
    const r = await this.device.controlTransferIn(
      { requestType: 'vendor', recipient: 'device', request, value: 0, index: value },
      1,
    );
    if (r.status !== 'ok' || !r.data?.getUint8(0)) throw new Error(`HackRF refused gain ${value} dB`);
  }

  private async out(request: number, value: number, index: number, data?: BufferSource) {
    const r = await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request, value, index }, data);
    if (r.status !== 'ok') throw new Error(`HackRF request ${request} failed: ${r.status}`);
  }
}
