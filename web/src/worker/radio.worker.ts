import { DemoRadio } from '../radio/demo';
import { HackRf } from '../radio/hackrf';
import { RtlSdr } from '../radio/rtlsdr';
import { RadioSources, type RadioSource } from '../radio/sources';
import { isHackRf, type RadioDriver } from '../radio/types';
import { explainUsbError } from '../radio/usbErrors';
import { ScanEngine, type ScanEvent } from '../scan/engine';
import type { WorkerReply, WorkerRequest } from './protocol';

let driver: RadioDriver | null = null;
let engine: ScanEngine | null = null;
let streaming = false;

function reply(message: WorkerReply, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(message, transfer);
}

function transferablesOf(event: ScanEvent): Transferable[] {
  if (event.type === 'spectrum') return [event.db.buffer as ArrayBuffer];
  if (event.type === 'audio') return [event.samples.buffer as ArrayBuffer];
  return [];
}

async function connect(source: RadioSource) {
  let kind: 'demo' | 'rtlsdr' | 'hackrf' | 'unknown' = 'unknown';
  try {
    let d: RadioDriver;
    if (source.kind === 'demo') {
      kind = 'demo';
      d = new DemoRadio(source.index);
    } else {
      const device = RadioSources.pick(await navigator.usb.getDevices(), source);
      if (!device) throw new Error('The radio is no longer available. Unplug it, plug it back in, and add it again.');
      kind = isHackRf(device) ? 'hackrf' : 'rtlsdr';
      d = kind === 'hackrf' ? new HackRf(device) : new RtlSdr(device);
    }
    await d.open();
    const opened = d;
    driver = opened;
    engine = new ScanEngine({
      sampleRate: opened.info.sampleRate,
      minHz: opened.info.minHz,
      get latencySamples() {
        return opened.latencySamples;
      },
      now: () => performance.now(),
      tune: (hz) => opened.setFrequency(hz),
      emit: (event) => {
        reply({ type: 'event', event }, transferablesOf(event));
        if (event.type === 'error') void stopStream();
      },
    });
    reply({ type: 'connected', info: opened.info });
  } catch (error) {
    reply({ type: 'failed', message: explainUsbError(error, kind) });
  }
}

async function startStream() {
  if (streaming || !driver) return;
  streaming = true;
  await driver.start(
    (iq) => engine?.pushIq(iq),
    (error) => {
      engine?.stop();
      streaming = false;
      reply({ type: 'failed', message: explainUsbError(error, driver?.info.kind ?? 'unknown') });
      reply({ type: 'stopped' });
    },
  );
}

async function stopStream() {
  if (!streaming || !driver) return;
  streaming = false;
  await driver.stop();
  reply({ type: 'stopped' });
}

async function handle(data: WorkerRequest) {
  try {
    switch (data.type) {
      case 'connect':
        await connect(data.source);
        break;
      case 'start':
        await startStream();
        engine?.start(data.config);
        break;
      case 'stop':
        engine?.stop();
        await stopStream();
        break;
      case 'timing':
        engine?.updateTiming(data);
        break;
      case 'gain':
        await driver?.setGainDb(data.db);
        break;
      case 'ppm':
        await driver?.setPpm(data.ppm);
        break;
      case 'audio':
        engine?.setAudioEnabled(data.enabled);
        break;
      case 'excludes':
        engine?.setExcludes(data.freqs);
        break;
      case 'skips':
        engine?.setSkips(data.freqs);
        break;
      case 'next':
        engine?.next();
        break;
      case 'close':
        try {
          engine?.stop();
          await stopStream();
          await driver?.close();
        } finally {
          self.close();
        }
        break;
    }
  } catch (error) {
    reply({ type: 'failed', message: explainUsbError(error, driver?.info.kind ?? 'unknown') });
  }
}

// One at a time, in order: a quick Start then Stop must not overlap on the USB connection.
let queue: Promise<void> = Promise.resolve();
self.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  queue = queue.then(() => handle(data));
};
