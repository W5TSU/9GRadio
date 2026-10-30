import { CHANNEL_WIDTH_HZ, type Mode } from '../dsp/demod';

export interface HitRow {
  freqHz: number;
  mode: Mode;
  count: number;
  firstHeard: number;
  lastHeard: number;
  levelDb: number;
  snrDb: number;
  radioName: string;
  skipped: boolean;
  packetCount: number;
  latestStation?: string;
}

export interface HitInput {
  freqHz: number;
  mode: Mode;
  levelDb: number;
  snrDb: number;
  radioName: string;
  at: number;
}

/** A hit this soon after the row was last heard is the same transmission. */
const SAME_TRANSMISSION_MS = 5000;

export function sameChannel(a: number, b: number, mode: Mode): boolean {
  return Math.abs(a - b) < CHANNEL_WIDTH_HZ[mode] / 2;
}

/** The found-signal list: one row per frequency, including what is skipped. */
export class HitLog {
  private readonly list: HitRow[];

  constructor(saved: HitRow[] = []) {
    this.list = saved.map((r) => ({ ...r }));
  }

  rows(): HitRow[] {
    return [...this.list].sort((a, b) => b.lastHeard - a.lastHeard);
  }

  find(freqHz: number): HitRow | undefined {
    return this.list.find((r) => sameChannel(r.freqHz, freqHz, r.mode));
  }

  recordHit(h: HitInput): HitRow {
    const row = this.find(h.freqHz);
    if (!row) {
      const fresh: HitRow = {
        freqHz: h.freqHz,
        mode: h.mode,
        count: 1,
        firstHeard: h.at,
        lastHeard: h.at,
        levelDb: h.levelDb,
        snrDb: h.snrDb,
        radioName: h.radioName,
        skipped: false,
        packetCount: 0,
      };
      this.list.push(fresh);
      return fresh;
    }
    if (h.at - row.lastHeard > SAME_TRANSMISSION_MS) row.count++;
    // A voice radio hearing a data frequency must not hide the packets filed under it.
    if (row.packetCount === 0) row.mode = h.mode;
    row.lastHeard = h.at;
    row.levelDb = h.levelDb;
    row.snrDb = h.snrDb;
    row.radioName = h.radioName;
    return row;
  }

  /** Keeps a row fresh while a radio is listening to it. */
  touch(freqHz: number, levelDb: number, snrDb: number, at: number) {
    const row = this.find(freqHz);
    if (!row) return;
    row.lastHeard = at;
    row.levelDb = levelDb;
    row.snrDb = snrDb;
  }

  recordPacket(freqHz: number, station: string, at: number): HitRow | undefined {
    const row = this.find(freqHz);
    if (!row) return undefined;
    row.packetCount++;
    row.latestStation = station;
    row.lastHeard = at;
    return row;
  }

  setSkipped(freqHz: number, skipped: boolean): HitRow | undefined {
    const row = this.find(freqHz);
    if (row) row.skipped = skipped;
    return row;
  }

  skippedFreqs(): number[] {
    return this.list.filter((r) => r.skipped).map((r) => r.freqHz);
  }

  /** Empties the list but keeps skip marks, so clearing never un-skips anything. */
  clearUnskipped(): HitRow[] {
    const removed = this.list.filter((r) => !r.skipped);
    const kept = this.list.filter((r) => r.skipped);
    this.list.length = 0;
    this.list.push(...kept);
    return removed;
  }
}
