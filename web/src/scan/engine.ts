import { AUDIO_RATE, CHANNEL_WIDTH_HZ, ChannelDemod, type Mode } from '../dsp/demod';
import { PowerSpectrum } from '../dsp/spectrum';
import { AfskDecoder } from '../decoders/afsk';
import { parseAprs, type AprsPacket } from '../decoders/aprs';
import { detectSignals, noiseFloorDb, type DetectedSignal } from './detect';
import { StopRule, type StopState } from './stopRule';

export interface ScanConfig {
  startHz: number;
  stopHz: number;
  stepHz: number;
  mode: Mode;
  /** The "strong" line: dB above the noise floor. */
  marginDb: number;
  /** n: the minimum stay on a found signal. */
  minStayMs: number;
  /** x: the quiet delay before going back to scanning. */
  delayMs: number;
}

export type ScanPhase = 'idle' | 'scanning' | 'probing' | 'parked';

export type ScanEvent =
  | { type: 'spectrum'; startHz: number; binHz: number; db: Float32Array; floorDb: number; thresholdDb: number }
  | { type: 'hit'; freqHz: number; mode: Mode; levelDb: number; snrDb: number; stopped: boolean }
  | { type: 'parked'; freqHz: number; mode: Mode; levelDb: number; snrDb: number }
  | { type: 'released'; freqHz: number; heldMs: number }
  | { type: 'audio'; samples: Float32Array }
  | { type: 'error'; message: string }
  | { type: 'packet'; freqHz: number; packet: AprsPacket; levelDb: number; snrDb: number }
  | {
      type: 'status';
      phase: ScanPhase;
      centerHz: number;
      freqHz?: number;
      sinceMs?: number;
      stop?: StopState;
      remainingMs?: number;
      signalOn?: boolean;
      levelDb?: number;
      snrDb?: number;
    };

export interface ScanHost {
  readonly sampleRate: number;
  /** Samples that can still arrive from before a retune. */
  readonly latencySamples: number;
  /** Lowest frequency the radio can tune. */
  readonly minHz?: number;
  now(): number;
  tune(hz: number): Promise<void>;
  emit(event: ScanEvent): void;
}

const SLICE_HALF_FRACTION = 0.45;
const HOP_FRACTION = 0.9;
const EDGE_FRACTION = 0.05;
const BLOCK_AVERAGES = 3;
const DC_GUARD_BINS = 6;
const SETTLE_MS = 8;
const MIN_FFT = 2048;
const MAX_FFT = 16384;
/** Limits snapshot work on a band that needs no retuning. */
const SNAPSHOT_INTERVAL_MS = 20;
const METER_INTERVAL_MS = 60;
const STATUS_INTERVAL_MS = 250;
/** Off by this much below the line before a parked signal counts as gone. */
const SIGNAL_HYSTERESIS_DB = 3;
const AUDIO_GATE_HANG_MS = 250;
const PROBE_LIMIT_MS = 3000;
const PROBE_QUIET_MS = 500;
const REJECT_AFTER_PROBE_MS = 15_000;
const NEXT_PAUSE_MS = 5000;
const PARK_DC_MARGIN_HZ = 20_000;

/** Tuned frequencies that cover a band, shifted on odd sweeps so the DC hole moves. */
export function planSlices(startHz: number, stopHz: number, fs: number, sweep: number, minHz = 0): number[] {
  const width = stopHz - startHz;
  const mid = (startHz + stopHz) / 2;
  if (width <= 0.35 * fs) return [mid - 0.2 * fs >= minHz ? mid - 0.2 * fs : mid + 0.2 * fs];
  const half = SLICE_HALF_FRACTION * fs;
  const shift = sweep % 2 ? 0.3 * fs : 0;
  const slices: number[] = [];
  let c = Math.max(startHz + half - shift, minHz);
  for (;;) {
    slices.push(c);
    if (c + half >= stopHz) return slices;
    c += HOP_FRACTION * fs;
  }
}

function fftSizeFor(stepHz: number, fs: number): number {
  let n = MIN_FFT;
  while (n < MAX_FFT && fs / n > stepHz / 2) n <<= 1;
  return n;
}

/** Where a mode's carrier sits relative to the energy seen on the spectrum. */
function carrierOf(s: DetectedSignal, mode: Mode): number {
  switch (mode) {
    case 'USB':
      return s.lowHz - 300;
    case 'LSB':
      return s.highHz + 300;
    case 'AM':
    case 'CW':
      return s.peakHz;
    default:
      return s.centerHz;
  }
}

interface Candidate {
  freqHz: number;
  levelDb: number;
  snrDb: number;
}

/**
 * The scan loop for one radio. It is driven by the IQ blocks pushed into it, and
 * has no timers of its own, so a stalled radio simply pauses it.
 */
export class ScanEngine {
  private cfg: ScanConfig | null = null;
  private phase: ScanPhase = 'idle';
  private tuning = false;
  private dropSamples = 0;
  private generation = 0;

  private slices: number[] = [];
  private sliceIndex = 0;
  private sweep = 0;
  private centerHz = 0;

  private spectrum: PowerSpectrum | null = null;
  private capture = new Float32Array(0);
  private captureFill = 0;
  private nextCaptureAt = 0;

  private skips: number[] = [];
  private excludes: number[] = [];
  private readonly paused = new Map<number, number>();
  private audioEnabled = false;

  private target: Candidate | null = null;
  private targetSince = 0;
  private demod: ChannelDemod | null = null;
  private decoder: AfskDecoder | null = null;
  private stopRule: StopRule | null = null;
  private signalOn = false;
  private lastOnAt = 0;
  private gateUntil = 0;
  private lastStatusAt = 0;

  constructor(private readonly host: ScanHost) {}

  start(cfg: ScanConfig) {
    this.generation++;
    this.cfg = cfg;
    this.clearTarget();
    this.paused.clear();
    this.sweep = 0;
    this.spectrum = new PowerSpectrum(fftSizeFor(cfg.stepHz, this.host.sampleRate));
    this.capture = new Float32Array(this.spectrum.size * BLOCK_AVERAGES * 2);
    this.slices = planSlices(cfg.startHz, cfg.stopHz, this.host.sampleRate, 0, this.host.minHz);
    this.sliceIndex = 0;
    this.phase = 'scanning';
    this.tuneTo(this.slices[0]);
    this.emitStatus();
  }

  /** Changes the strong line and the stay times without disturbing the scan. */
  updateTiming(update: Pick<ScanConfig, 'marginDb' | 'minStayMs' | 'delayMs'>) {
    if (this.cfg) this.cfg = { ...this.cfg, ...update };
  }

  stop() {
    this.generation++;
    this.clearTarget();
    this.cfg = null;
    this.phase = 'idle';
    this.tuning = false;
  }

  next() {
    if (!this.target) return;
    this.paused.set(this.target.freqHz, this.host.now() + NEXT_PAUSE_MS);
    this.release();
  }

  setSkips(freqs: number[]) {
    this.skips = freqs;
    this.releaseIfBlocked();
  }

  setExcludes(freqs: number[]) {
    this.excludes = freqs;
    this.releaseIfBlocked();
  }

  setAudioEnabled(enabled: boolean) {
    this.audioEnabled = enabled;
  }

  pushIq(iq: Float32Array) {
    if (this.phase === 'idle' || this.tuning) return;
    let block = iq;
    if (this.dropSamples > 0) {
      const n = block.length >> 1;
      if (this.dropSamples >= n) {
        this.dropSamples -= n;
        return;
      }
      block = block.subarray(this.dropSamples * 2);
      this.dropSamples = 0;
    }
    if (this.phase === 'scanning') this.scanBlock(block);
    else this.listenBlock(block);
  }

  private scanBlock(iq: Float32Array) {
    if (this.host.now() < this.nextCaptureAt) return;
    if (this.fillCapture(iq)) this.onSnapshot();
  }

  private fillCapture(iq: Float32Array): boolean {
    const take = Math.min(iq.length, this.capture.length - this.captureFill);
    this.capture.set(iq.subarray(0, take), this.captureFill);
    this.captureFill += take;
    if (this.captureFill < this.capture.length) return false;
    this.captureFill = 0;
    return true;
  }

  private measure() {
    const cfg = this.cfg!;
    const spectrum = this.spectrum!;
    const db = spectrum.compute(this.capture, BLOCK_AVERAGES);
    const floorDb = noiseFloorDb(db);
    const thresholdDb = floorDb + cfg.marginDb;
    const binHz = this.host.sampleRate / spectrum.size;

    const crop = Math.floor(db.length * EDGE_FRACTION);
    const half = db.length >> 1;
    this.host.emit({
      type: 'spectrum',
      startHz: this.centerHz + (crop - half) * binHz,
      binHz,
      db: db.slice(crop, db.length - crop),
      floorDb,
      thresholdDb,
    });
    return { db, floorDb, thresholdDb, binHz };
  }

  private onSnapshot() {
    const cfg = this.cfg!;
    const { db, floorDb, thresholdDb, binHz } = this.measure();
    const found = detectSignals(db, {
      centerHz: this.centerHz,
      binHz,
      thresholdDb,
      mergeGapHz: CHANNEL_WIDTH_HZ[cfg.mode] / 2,
      dcGuardHz: DC_GUARD_BINS * binHz,
      edgeFraction: EDGE_FRACTION,
    });

    const byFreq = new Map<number, Candidate>();
    for (const s of found) {
      const freqHz = Math.round(carrierOf(s, cfg.mode) / cfg.stepHz) * cfg.stepHz;
      if (freqHz < cfg.startHz || freqHz > cfg.stopHz || this.isBlocked(freqHz)) continue;
      const seen = byFreq.get(freqHz);
      if (!seen || s.peakDb > seen.levelDb) byFreq.set(freqHz, { freqHz, levelDb: s.peakDb, snrDb: s.peakDb - floorDb });
    }

    const candidates = [...byFreq.values()].sort((a, b) => b.levelDb - a.levelDb);
    if (candidates.length === 0) {
      this.advance();
      return;
    }

    const [best, ...others] = candidates;
    if (cfg.mode === 'APRS') {
      this.listenTo(best, 'probing');
      return;
    }
    for (const o of others) this.emitHit(o, false);
    this.emitHit(best, true);
    this.listenTo(best, 'parked');
  }

  private emitHit(c: Candidate, stopped: boolean) {
    this.host.emit({ type: 'hit', freqHz: c.freqHz, mode: this.cfg!.mode, levelDb: c.levelDb, snrDb: c.snrDb, stopped });
  }

  private listenTo(c: Candidate, phase: 'probing' | 'parked') {
    const cfg = this.cfg!;
    const fs = this.host.sampleRate;
    const now = this.host.now();
    this.target = c;
    this.targetSince = now;
    this.signalOn = true;
    this.lastOnAt = now;
    this.gateUntil = now + AUDIO_GATE_HANG_MS;
    this.phase = phase;
    this.captureFill = 0;
    this.nextCaptureAt = now + METER_INTERVAL_MS;

    const halfWidth = CHANNEL_WIDTH_HZ[cfg.mode] / 2;
    const offset = Math.abs(c.freqHz - this.centerHz);
    const usable = offset >= halfWidth + PARK_DC_MARGIN_HZ && offset <= SLICE_HALF_FRACTION * fs - halfWidth;
    if (!usable) this.tuneTo(c.freqHz - fs / 4 >= (this.host.minHz ?? 0) ? c.freqHz - fs / 4 : c.freqHz + fs / 4);

    this.demod = new ChannelDemod(cfg.mode, fs, c.freqHz - this.centerHz);
    this.decoder = cfg.mode === 'APRS' ? new AfskDecoder(AUDIO_RATE) : null;
    if (phase === 'parked') this.beginStay();
    else this.emitStatus();
  }

  private beginStay() {
    const c = this.target!;
    const cfg = this.cfg!;
    const now = this.host.now();
    this.stopRule = new StopRule(cfg.minStayMs, cfg.delayMs, now);
    this.targetSince = now;
    this.phase = 'parked';
    this.host.emit({ type: 'parked', freqHz: c.freqHz, mode: cfg.mode, levelDb: c.levelDb, snrDb: c.snrDb });
    this.emitStatus();
  }

  private listenBlock(iq: Float32Array) {
    const now = this.host.now();
    const audio = this.demod!.process(iq);

    if (this.decoder) {
      for (const frame of this.decoder.push(this.demod!.flatFm)) {
        const c = this.target!;
        if (this.phase === 'probing') {
          this.emitHit(c, true);
          this.beginStay();
        }
        this.host.emit({
          type: 'packet',
          freqHz: c.freqHz,
          packet: parseAprs(frame),
          levelDb: c.levelDb,
          snrDb: c.snrDb,
        });
      }
    }

    if (this.phase === 'parked' && this.audioEnabled && audio.length && now <= this.gateUntil) {
      this.host.emit({ type: 'audio', samples: audio.slice() });
    }

    if (now >= this.nextCaptureAt && this.fillCapture(iq)) {
      this.nextCaptureAt = now + METER_INTERVAL_MS;
      this.updateSignal();
      if (this.phase === 'idle' || this.phase === 'scanning') return;
    }

    if (this.phase === 'probing') this.checkProbe(now);
    else this.checkStay(now);

    if (this.target && now - this.lastStatusAt >= STATUS_INTERVAL_MS) this.emitStatus();
  }

  private updateSignal() {
    const c = this.target!;
    const cfg = this.cfg!;
    const { db, floorDb, thresholdDb, binHz } = this.measure();
    const half = db.length >> 1;
    const halfWidth = CHANNEL_WIDTH_HZ[cfg.mode] / 2;
    const first = Math.max(0, Math.round((c.freqHz - halfWidth - this.centerHz) / binHz) + half);
    const last = Math.min(db.length - 1, Math.round((c.freqHz + halfWidth - this.centerHz) / binHz) + half);
    let peak = -Infinity;
    for (let i = first; i <= last; i++) if (db[i] > peak) peak = db[i];

    const now = this.host.now();
    this.signalOn = peak >= thresholdDb - SIGNAL_HYSTERESIS_DB;
    if (this.signalOn) {
      this.lastOnAt = now;
      this.gateUntil = now + AUDIO_GATE_HANG_MS;
      c.levelDb = peak;
      c.snrDb = peak - floorDb;
    }
  }

  private checkProbe(now: number) {
    if (now - this.targetSince >= PROBE_LIMIT_MS) {
      // On the air this long with no packet: not APRS, so don't test it again for a while.
      this.paused.set(this.target!.freqHz, now + REJECT_AFTER_PROBE_MS);
      this.leaveTarget();
    } else if (now - this.lastOnAt >= PROBE_QUIET_MS) {
      this.leaveTarget();
    }
  }

  private checkStay(now: number) {
    if (this.stopRule!.update(now, this.signalOn) === 'done') this.release();
  }

  private release() {
    const c = this.target!;
    if (this.phase === 'parked') {
      this.host.emit({ type: 'released', freqHz: c.freqHz, heldMs: this.host.now() - this.targetSince });
    }
    this.leaveTarget();
  }

  private leaveTarget() {
    this.clearTarget();
    this.phase = 'scanning';
    this.advance();
    this.emitStatus();
  }

  private clearTarget() {
    this.target = null;
    this.demod = null;
    this.decoder = null;
    this.stopRule = null;
    this.captureFill = 0;
  }

  private releaseIfBlocked() {
    if (this.target && this.isBlocked(this.target.freqHz)) this.release();
  }

  private isBlocked(freqHz: number): boolean {
    const tolerance = CHANNEL_WIDTH_HZ[this.cfg?.mode ?? 'NFM'] / 2;
    const near = (x: number) => Math.abs(x - freqHz) < tolerance;
    if (this.skips.some(near) || this.excludes.some(near)) return true;
    const now = this.host.now();
    for (const [f, until] of this.paused) {
      if (now >= until) this.paused.delete(f);
      else if (near(f)) return true;
    }
    return false;
  }

  /** Moves to the next slice, or takes another look if the band is a single slice. */
  private advance() {
    const fs = this.host.sampleRate;
    const cfg = this.cfg!;
    this.captureFill = 0;
    this.sliceIndex++;
    if (this.sliceIndex >= this.slices.length) {
      this.sweep++;
      this.slices = planSlices(cfg.startHz, cfg.stopHz, fs, this.sweep, this.host.minHz);
      this.sliceIndex = 0;
    }
    const target = this.slices[this.sliceIndex];
    if (target !== this.centerHz) this.tuneTo(target);
    else this.nextCaptureAt = this.host.now() + SNAPSHOT_INTERVAL_MS;
  }

  private tuneTo(hz: number) {
    this.centerHz = hz;
    this.tuning = true;
    this.captureFill = 0;
    this.nextCaptureAt = 0;
    const generation = this.generation;
    this.host.tune(hz).then(
      () => {
        if (generation !== this.generation) return;
        this.tuning = false;
        this.dropSamples = this.host.latencySamples + Math.ceil((this.host.sampleRate * SETTLE_MS) / 1000);
      },
      (error: unknown) => {
        if (generation !== this.generation) return;
        this.stop();
        this.host.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        this.emitStatus();
      },
    );
  }

  private emitStatus() {
    const now = this.host.now();
    this.lastStatusAt = now;
    const c = this.target;
    this.host.emit({
      type: 'status',
      phase: this.phase,
      centerHz: this.centerHz,
      freqHz: c?.freqHz,
      sinceMs: c ? this.targetSince : undefined,
      stop: this.stopRule?.current,
      remainingMs: this.stopRule?.remainingMs(now),
      signalOn: c ? this.signalOn : undefined,
      levelDb: c?.levelDb,
      snrDb: c?.snrDb,
    });
  }
}
