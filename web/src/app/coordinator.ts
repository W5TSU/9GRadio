import type { Mode } from '../dsp/demod';
import type { ScanEvent } from '../scan/engine';
import type { PacketRecord } from './csv';
import { sameChannel, type HitLog, type HitRow } from './hitLog';

/** What the coordinator tells a radio to do. */
export type RadioCommand =
  | { type: 'audio'; enabled: boolean }
  | { type: 'excludes'; freqs: number[] }
  | { type: 'skips'; freqs: number[] }
  | { type: 'next' };

export interface CoordinatorDeps {
  log: HitLog;
  send(radioId: string, command: RadioCommand): void;
  now(): number;
  saveHit(row: HitRow): void;
  savePacket(record: PacketRecord): void;
}

interface Parked {
  radioId: string;
  freqHz: number;
  mode: Mode;
  snrDb: number;
}

/** A radio told to leave a signal because another radio hears it better. */
interface Exclusion {
  loser: string;
  winner: string;
  freqHz: number;
}

/**
 * Decides what plays when several radios are scanning: which radio keeps a
 * signal both can hear, and what happens when they find different signals.
 */
export class Coordinator {
  private readonly names = new Map<string, string>();
  /** Radios stopped on a signal, oldest first. */
  private parked: Parked[] = [];
  private player: Parked | null = null;
  private exclusions: Exclusion[] = [];
  private packetListeners: ((record: PacketRecord) => void)[] = [];
  private changeListeners: (() => void)[] = [];

  constructor(private readonly deps: CoordinatorDeps) {}

  addRadio(radioId: string, name: string) {
    this.names.set(radioId, name);
    this.deps.send(radioId, { type: 'skips', freqs: this.deps.log.skippedFreqs() });
    this.changed();
  }

  removeRadio(radioId: string) {
    this.radioStopped(radioId);
    this.names.delete(radioId);
    this.changed();
  }

  radioName(radioId: string): string {
    return this.names.get(radioId) ?? radioId;
  }

  playing(): { radioId: string; freqHz: number } | null {
    return this.player ? { radioId: this.player.radioId, freqHz: this.player.freqHz } : null;
  }

  /** Signals a radio is stopped on, but that aren't the one playing. */
  liveFreqs(): number[] {
    return this.parked.filter((p) => p !== this.player).map((p) => p.freqHz);
  }

  parkedRadio(radioId: string): number | undefined {
    return this.parked.find((p) => p.radioId === radioId)?.freqHz;
  }

  onPacket(listener: (record: PacketRecord) => void) {
    this.packetListeners.push(listener);
  }

  onChange(listener: () => void) {
    this.changeListeners.push(listener);
  }

  onEvent(radioId: string, e: ScanEvent) {
    switch (e.type) {
      case 'hit': {
        const row = this.deps.log.recordHit({
          freqHz: e.freqHz,
          mode: e.mode,
          levelDb: e.levelDb,
          snrDb: e.snrDb,
          radioName: this.radioName(radioId),
          at: this.deps.now(),
        });
        this.deps.saveHit(row);
        this.changed();
        break;
      }
      case 'parked':
        this.handleParked({ radioId, freqHz: e.freqHz, mode: e.mode, snrDb: e.snrDb });
        this.changed();
        break;
      case 'released': {
        const row = this.deps.log.find(e.freqHz);
        if (row) this.deps.saveHit(row);
        this.leave(radioId);
        this.changed();
        break;
      }
      case 'status':
        if (e.phase === 'parked' && e.signalOn && e.freqHz !== undefined) {
          this.deps.log.touch(e.freqHz, e.levelDb ?? 0, e.snrDb ?? 0, this.deps.now());
          this.changed();
        }
        break;
      case 'packet': {
        const at = this.deps.now();
        const row = this.deps.log.recordPacket(e.freqHz, e.packet.source, at);
        const record: PacketRecord = {
          freqHz: row?.freqHz ?? e.freqHz,
          at,
          levelDb: e.levelDb,
          snrDb: e.snrDb,
          radioName: this.radioName(radioId),
          packet: e.packet,
        };
        if (row) this.deps.saveHit(row);
        this.deps.savePacket(record);
        for (const listener of this.packetListeners) listener(record);
        this.changed();
        break;
      }
    }
  }

  /** The user clicked a row: if a radio is live on it, play that radio. */
  select(freqHz: number) {
    const target = this.parked.find((p) => sameChannel(p.freqHz, freqHz, p.mode));
    if (target && target !== this.player) {
      this.playFrom(target);
      this.changed();
    }
  }

  skip(freqHz: number) {
    this.setSkipped(freqHz, true);
  }

  unskip(freqHz: number) {
    this.setSkipped(freqHz, false);
  }

  next() {
    if (this.player) this.deps.send(this.player.radioId, { type: 'next' });
  }

  /** A radio stopped scanning or disappeared, without having released normally. */
  radioStopped(radioId: string) {
    this.leave(radioId);
    this.exclusions = this.exclusions.filter((x) => x.loser !== radioId);
    this.changed();
  }

  /** Sends the current skip list to every radio, after the list was changed from outside. */
  refreshSkips() {
    const freqs = this.deps.log.skippedFreqs();
    for (const radioId of this.names.keys()) this.deps.send(radioId, { type: 'skips', freqs });
    this.changed();
  }

  private setSkipped(freqHz: number, skipped: boolean) {
    const row = this.deps.log.setSkipped(freqHz, skipped);
    if (row) this.deps.saveHit(row);
    this.refreshSkips();
  }

  private handleParked(fresh: Parked) {
    // Only radios looking for the same thing are duplicates: an APRS radio has a job to do
    // on a frequency even when a voice radio is listening there too.
    const same = this.parked.find(
      (p) => p.radioId !== fresh.radioId && p.mode === fresh.mode && sameChannel(p.freqHz, fresh.freqHz, fresh.mode),
    );
    if (!same) {
      this.parked.push(fresh);
      if (!this.player) this.playFrom(fresh);
      return;
    }
    if (fresh.snrDb > same.snrDb) {
      // The new radio hears it better. It takes over the older radio's place.
      const wasPlaying = this.player === same;
      this.parked = this.parked.filter((p) => p !== same);
      this.parked.push(fresh);
      if (wasPlaying) this.playFrom(fresh);
      this.exclude(same.radioId, fresh.radioId, same.freqHz);
    } else {
      this.exclude(fresh.radioId, same.radioId, fresh.freqHz);
    }
  }

  private exclude(loser: string, winner: string, freqHz: number) {
    this.exclusions.push({ loser, winner, freqHz });
    this.sendExcludes(loser);
  }

  private sendExcludes(radioId: string) {
    const freqs = this.exclusions.filter((x) => x.loser === radioId).map((x) => x.freqHz);
    this.deps.send(radioId, { type: 'excludes', freqs });
  }

  /** A radio is no longer stopped on its signal. Radios it beat may look again. */
  private leave(radioId: string) {
    const wasPlaying = this.player?.radioId === radioId;
    this.parked = this.parked.filter((p) => p.radioId !== radioId);
    if (wasPlaying) {
      this.deps.send(radioId, { type: 'audio', enabled: false });
      this.player = null;
      if (this.parked.length) this.playFrom(this.parked[0]);
    }
    const losers = this.exclusions.filter((x) => x.winner === radioId).map((x) => x.loser);
    this.exclusions = this.exclusions.filter((x) => x.winner !== radioId);
    for (const loser of new Set(losers)) this.sendExcludes(loser);
  }

  private playFrom(target: Parked) {
    if (this.player && this.player.radioId !== target.radioId) {
      this.deps.send(this.player.radioId, { type: 'audio', enabled: false });
    }
    this.player = target;
    this.deps.send(target.radioId, { type: 'audio', enabled: true });
  }

  private changed() {
    for (const listener of this.changeListeners) listener();
  }
}
