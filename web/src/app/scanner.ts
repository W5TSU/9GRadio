import { CHANNEL_WIDTH_HZ } from '../dsp/demod';
import { sourceMatches, sourceOrdinal, type RadioSource } from '../radio/sources';
import { HACKRF_FILTERS, RTLSDR_FILTERS, type RadioInfo } from '../radio/types';
import { explainUsbError } from '../radio/usbErrors';
import type { ScanEvent, ScanPhase } from '../scan/engine';
import type { StopState } from '../scan/stopRule';
import type { WorkerReply, WorkerRequest } from '../worker/protocol';
import { AudioOut } from './audioOut';
import { Coordinator, type RadioCommand } from './coordinator';
import type { PacketRecord } from './csv';
import { HitLog, type HitRow } from './hitLog';
import { defaultSettings, loadSettings, saveSettings, type RadioSettings } from './settings';
import { ScannerStore } from './store';

export interface RadioStatus {
  phase: ScanPhase;
  freqHz?: number;
  stop?: StopState;
  remainingMs?: number;
  signalOn?: boolean;
  levelDb?: number;
  snrDb?: number;
}

/** One radio as the page sees it: its background worker, settings and last status. */
export class RadioHandle {
  info: RadioInfo | null = null;
  settings!: RadioSettings;
  status: RadioStatus = { phase: 'idle' };
  error: string | null = null;
  running = false;
  private readonly worker: Worker;

  constructor(
    readonly id: string,
    readonly source: RadioSource,
    private readonly onReply: (handle: RadioHandle, reply: WorkerReply) => void,
  ) {
    this.worker = new Worker(new URL('../worker/radio.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => this.onReply(this, data);
    this.worker.onerror = (e) => {
      this.onReply(this, { type: 'failed', message: e.message || 'The radio worker stopped unexpectedly.' });
    };
    this.post({ type: 'connect', source });
  }

  post(message: WorkerRequest) {
    this.worker.postMessage(message);
  }

  get settingsKey() {
    return `9gradio.radio.${this.info?.kind}.${this.info?.serial ?? this.id}`;
  }

  terminate() {
    this.post({ type: 'close' });
  }
}

export type SpectrumListener = (radioId: string, event: Extract<ScanEvent, { type: 'spectrum' }>) => void;

/** Everything behind the screen: the radios, the hit list, saving and audio. */
export class Scanner {
  readonly audio = new AudioOut();
  readonly log: HitLog;
  readonly coordinator: Coordinator;
  readonly radios = new Map<string, RadioHandle>();
  private nextId = 1;
  private demoCount = 0;
  private lastPlayer: string | null = null;
  private readonly listeners: (() => void)[] = [];
  private readonly spectrumListeners: SpectrumListener[] = [];

  private constructor(
    private readonly store: ScannerStore,
    savedRows: HitRow[],
  ) {
    this.log = new HitLog(savedRows);
    this.coordinator = new Coordinator({
      log: this.log,
      send: (radioId, command: RadioCommand) => this.radios.get(radioId)?.post(command),
      now: () => Date.now(),
      saveHit: (row) => void this.store.saveHit({ ...row }),
      savePacket: (record) => void this.store.savePacket(record),
    });
    this.coordinator.onChange(() => this.onCoordinatorChange());
  }

  static async open(): Promise<Scanner> {
    const store = await ScannerStore.open();
    return new Scanner(store, await store.loadHits());
  }

  get hasUsb() {
    return 'usb' in navigator;
  }

  onChange(listener: () => void) {
    this.listeners.push(listener);
  }

  onSpectrum(listener: SpectrumListener) {
    this.spectrumListeners.push(listener);
  }

  notify() {
    for (const listener of this.listeners) listener();
  }

  /** Picks up radios this browser has already been given permission to use. */
  async addPermittedRadios() {
    if (!this.hasUsb) return;
    const devices = await navigator.usb.getDevices();
    for (const device of devices) this.addUsb(devices, device);
  }

  /** A radio was pulled out. Returns its name, once its panel is gone. */
  radioUnplugged(device: USBDevice): string | null {
    for (const handle of this.radios.values()) {
      if (sourceMatches(handle.source, device)) {
        const name = handle.info?.name ?? 'A radio';
        this.removeRadio(handle);
        return name;
      }
    }
    return null;
  }

  /** Shows the browser's device chooser. Must be called from a click. */
  async chooseRadio() {
    await this.audio.resume();
    let device: USBDevice;
    try {
      device = await navigator.usb.requestDevice({ filters: [...RTLSDR_FILTERS, ...HACKRF_FILTERS] });
    } catch (error) {
      if ((error as DOMException).name === 'NotFoundError') return; // The chooser was cancelled.
      throw new Error(explainUsbError(error, 'unknown'));
    }
    const devices = await navigator.usb.getDevices();
    const listed = devices.find((d) => d === device) ?? device;
    this.addUsb(devices, listed);
  }

  addDemo() {
    void this.audio.resume();
    this.addHandle({ kind: 'demo', index: this.demoCount++ });
  }

  removeRadio(handle: RadioHandle) {
    this.coordinator.removeRadio(handle.id);
    handle.terminate();
    this.radios.delete(handle.id);
    this.notify();
  }

  start(handle: RadioHandle) {
    if (!handle.info) return;
    void this.audio.resume();
    const s = handle.settings;
    handle.running = true;
    handle.error = null;
    handle.post({ type: 'gain', db: s.gainDb });
    handle.post({ type: 'ppm', ppm: s.ppm });
    handle.post({
      type: 'start',
      config: {
        startHz: s.startHz,
        stopHz: s.stopHz,
        stepHz: s.stepHz,
        mode: s.mode,
        marginDb: s.marginDb,
        minStayMs: s.minStayS * 1000,
        delayMs: s.delayS * 1000,
      },
    });
    this.notify();
  }

  stop(handle: RadioHandle) {
    handle.running = false;
    handle.status = { phase: 'idle' };
    handle.post({ type: 'stop' });
    this.coordinator.radioStopped(handle.id);
    this.notify();
  }

  saveSettings(handle: RadioHandle) {
    saveSettings(localStorage, handle.settingsKey, handle.settings);
  }

  /** Sends the settings that can change without restarting the scan. */
  sendTiming(handle: RadioHandle) {
    const s = handle.settings;
    handle.post({ type: 'timing', marginDb: s.marginDb, minStayMs: s.minStayS * 1000, delayMs: s.delayS * 1000 });
    this.saveSettings(handle);
  }

  packetsFor(freqHz: number): Promise<PacketRecord[]> {
    return this.store.packetsFor(freqHz);
  }

  /** Empties the list but keeps skips. */
  async clearList() {
    const removed = this.log.clearUnskipped();
    await this.store.deleteHits(removed.map((r) => r.freqHz));
    this.notify();
  }

  /** Radio currently parked on this row's frequency, if any. */
  radioOn(row: HitRow): RadioHandle | undefined {
    for (const handle of this.radios.values()) {
      const f = this.coordinator.parkedRadio(handle.id);
      if (f !== undefined && Math.abs(f - row.freqHz) < CHANNEL_WIDTH_HZ[row.mode] / 2) return handle;
    }
    return undefined;
  }

  private addUsb(devices: USBDevice[], device: USBDevice) {
    const source: RadioSource = {
      kind: 'usb',
      vendorId: device.vendorId,
      productId: device.productId,
      serial: device.serialNumber ?? null,
      ordinal: sourceOrdinal(devices, device),
    };
    const onScreen = [...this.radios.values()].some((handle) => {
      const s = handle.source;
      return (
        s.kind === 'usb' &&
        s.vendorId === source.vendorId &&
        s.productId === source.productId &&
        s.serial === source.serial &&
        s.ordinal === source.ordinal
      );
    });
    if (!onScreen) this.addHandle(source);
  }

  private addHandle(source: RadioSource) {
    const id = `radio-${this.nextId++}`;
    const handle = new RadioHandle(id, source, (h, reply) => this.onReply(h, reply));
    this.radios.set(id, handle);
    this.notify();
  }

  private onReply(handle: RadioHandle, reply: WorkerReply) {
    switch (reply.type) {
      case 'connected':
        handle.info = reply.info;
        handle.settings = loadSettings(localStorage, handle.settingsKey, this.initialSettings(handle, reply.info));
        this.coordinator.addRadio(handle.id, reply.info.name);
        this.notify();
        break;
      case 'failed':
        handle.error = reply.message;
        handle.running = false;
        handle.status = { phase: 'idle' };
        this.coordinator.radioStopped(handle.id);
        this.notify();
        break;
      case 'stopped':
        handle.running = false;
        handle.status = { phase: 'idle' };
        this.coordinator.radioStopped(handle.id);
        this.notify();
        break;
      case 'event':
        this.onScanEvent(handle, reply.event);
        break;
    }
  }

  /** So two demo radios show two different things out of the box. */
  private initialSettings(handle: RadioHandle, info: RadioInfo): RadioSettings {
    const defaults = defaultSettings(info);
    if (handle.source.kind === 'demo' && handle.source.index % 2 === 1) {
      return { ...defaults, startHz: 144_380_000, stopHz: 144_400_000, stepHz: 5_000, mode: 'APRS' };
    }
    return defaults;
  }

  private onScanEvent(handle: RadioHandle, event: ScanEvent) {
    switch (event.type) {
      case 'spectrum':
        for (const listener of this.spectrumListeners) listener(handle.id, event);
        return;
      case 'audio':
        // A stale block can still arrive just after the audio moved to another radio.
        if (this.coordinator.playing()?.radioId === handle.id) this.audio.push(event.samples);
        return;
      case 'status':
        handle.status = {
          phase: event.phase,
          freqHz: event.freqHz,
          stop: event.stop,
          remainingMs: event.remainingMs,
          signalOn: event.signalOn,
          levelDb: event.levelDb,
          snrDb: event.snrDb,
        };
        this.coordinator.onEvent(handle.id, event);
        this.notify();
        return;
      case 'error':
        handle.error = event.message;
        handle.running = false;
        this.notify();
        return;
      default:
        this.coordinator.onEvent(handle.id, event);
    }
  }

  private onCoordinatorChange() {
    const player = this.coordinator.playing()?.radioId ?? null;
    if (player !== this.lastPlayer) {
      this.audio.flush();
      this.lastPlayer = player;
    }
    this.notify();
  }
}
