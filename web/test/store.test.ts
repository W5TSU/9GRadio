import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ScannerStore } from '../src/app/store';
import type { HitRow } from '../src/app/hitLog';
import type { PacketRecord } from '../src/app/csv';
import { parseAprs } from '../src/decoders/aprs';

const row = (freqHz: number, over: Partial<HitRow> = {}): HitRow => ({
  freqHz,
  mode: 'NFM',
  count: 1,
  firstHeard: 1000,
  lastHeard: 1000,
  levelDb: -50,
  snrDb: 30,
  radioName: 'RTL-SDR',
  skipped: false,
  packetCount: 0,
  ...over,
});

const packet = (freqHz: number, at: number): PacketRecord => ({
  freqHz,
  at,
  levelDb: -60,
  snrDb: 25,
  radioName: 'RTL-SDR',
  packet: parseAprs({ source: 'KE5ABC-9', destination: 'APRS', path: [], info: `>at ${at}` }),
});

let dbNumber = 0;
const open = (name: string) => ScannerStore.open(name);

describe('ScannerStore', () => {
  let name: string;
  beforeEach(() => {
    name = `test-${++dbNumber}`;
  });

  it('brings hit rows back after the browser is reopened', async () => {
    const a = await open(name);
    await a.saveHit(row(146_520_000, { skipped: true }));
    await a.saveHit(row(146_940_000));
    a.close();
    const b = await open(name);
    const rows = await b.loadHits();
    expect(rows.map((r) => r.freqHz).sort()).toEqual([146_520_000, 146_940_000]);
    expect(rows.find((r) => r.freqHz === 146_520_000)?.skipped).toBe(true);
  });

  it('overwrites a row saved again for the same frequency', async () => {
    const s = await open(name);
    await s.saveHit(row(146_520_000));
    await s.saveHit(row(146_520_000, { count: 9 }));
    const rows = await s.loadHits();
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(9);
  });

  it('removes a deleted row', async () => {
    const s = await open(name);
    await s.saveHit(row(146_520_000));
    await s.deleteHits([146_520_000]);
    expect(await s.loadHits()).toEqual([]);
  });

  it('returns every packet for a frequency, newest first', async () => {
    const s = await open(name);
    await s.savePacket(packet(144_390_000, 1000));
    await s.savePacket(packet(144_390_000, 3000));
    await s.savePacket(packet(144_390_000, 2000));
    await s.savePacket(packet(145_825_000, 4000));
    const list = await s.packetsFor(144_390_000);
    expect(list.map((p) => p.at)).toEqual([3000, 2000, 1000]);
    expect(list[0].packet.comment).toBe('at 3000');
  });

  it('deletes the packets of a removed frequency', async () => {
    const s = await open(name);
    await s.savePacket(packet(144_390_000, 1000));
    await s.savePacket(packet(145_825_000, 2000));
    await s.deleteHits([144_390_000]);
    expect(await s.packetsFor(144_390_000)).toEqual([]);
    expect(await s.packetsFor(145_825_000)).toHaveLength(1);
  });
});
