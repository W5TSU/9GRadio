import { beforeEach, describe, expect, it } from 'vitest';
import { Coordinator, type RadioCommand } from '../src/app/coordinator';
import { HitLog } from '../src/app/hitLog';
import { parseAprs } from '../src/decoders/aprs';
import type { ScanEvent } from '../src/scan/engine';

const F1 = 146_520_000;
const F2 = 146_940_000;

let sent: { radioId: string; cmd: RadioCommand }[];
let log: HitLog;
let saved: unknown[];
let time: number;
let c: Coordinator;

const parked = (freqHz: number, snrDb = 30): ScanEvent => ({ type: 'parked', freqHz, mode: 'NFM', levelDb: -50, snrDb });
const released = (freqHz: number): ScanEvent => ({ type: 'released', freqHz, heldMs: 1000 });
const hit = (freqHz: number, snrDb = 30, stopped = true): ScanEvent => ({
  type: 'hit',
  freqHz,
  mode: 'NFM',
  levelDb: -50,
  snrDb,
  stopped,
});

const audioTo = (id: string) => sent.filter((s) => s.radioId === id && s.cmd.type === 'audio').map((s) => (s.cmd as { enabled: boolean }).enabled);
const excludesTo = (id: string) => sent.filter((s) => s.radioId === id && s.cmd.type === 'excludes').map((s) => (s.cmd as { freqs: number[] }).freqs);
const skipsTo = (id: string) => sent.filter((s) => s.radioId === id && s.cmd.type === 'skips').map((s) => (s.cmd as { freqs: number[] }).freqs);

beforeEach(() => {
  sent = [];
  saved = [];
  time = 1000;
  log = new HitLog();
  c = new Coordinator({
    log,
    send: (radioId, cmd) => sent.push({ radioId, cmd }),
    now: () => time,
    saveHit: (row) => saved.push(row),
    savePacket: (p) => saved.push(p),
  });
  c.addRadio('a', 'RTL-SDR');
  c.addRadio('b', 'HackRF');
  sent = [];
});

describe('Coordinator: one radio', () => {
  it('plays the first radio that stops', () => {
    c.onEvent('a', parked(F1));
    expect(c.playing()).toEqual({ radioId: 'a', freqHz: F1 });
    expect(audioTo('a')).toEqual([true]);
  });

  it('logs a found signal and saves it', () => {
    c.onEvent('a', hit(F1));
    expect(log.rows()[0]).toMatchObject({ freqHz: F1, radioName: 'RTL-SDR', count: 1 });
    expect(saved).toHaveLength(1);
  });

  it('stops playing when the radio goes back to scanning', () => {
    c.onEvent('a', parked(F1));
    sent = [];
    c.onEvent('a', released(F1));
    expect(c.playing()).toBeNull();
    expect(audioTo('a')).toEqual([false]);
  });

  it('keeps the row up to date while parked', () => {
    c.onEvent('a', hit(F1));
    c.onEvent('a', parked(F1));
    time = 9000;
    c.onEvent('a', {
      type: 'status',
      phase: 'parked',
      centerHz: F1,
      freqHz: F1,
      signalOn: true,
      levelDb: -42,
      snrDb: 38,
    });
    expect(log.rows()[0]).toMatchObject({ lastHeard: 9000, levelDb: -42, snrDb: 38 });
  });

  it('does not freshen the row while parked with the signal off', () => {
    c.onEvent('a', hit(F1));
    c.onEvent('a', parked(F1));
    time = 9000;
    c.onEvent('a', { type: 'status', phase: 'parked', centerHz: F1, freqHz: F1, signalOn: false, levelDb: -42, snrDb: 38 });
    expect(log.rows()[0].lastHeard).toBe(1000);
  });
});

describe('Coordinator: the same signal on two radios', () => {
  it('keeps the first radio when the second hears it weaker', () => {
    c.onEvent('a', parked(F1, 30));
    sent = [];
    c.onEvent('b', parked(F1, 20));
    expect(c.playing()).toEqual({ radioId: 'a', freqHz: F1 });
    expect(excludesTo('b')).toEqual([[F1]]);
    expect(audioTo('a')).toEqual([]);
  });

  it('switches to the second radio when it hears it stronger', () => {
    c.onEvent('a', parked(F1, 20));
    sent = [];
    c.onEvent('b', parked(F1, 30));
    expect(c.playing()).toEqual({ radioId: 'b', freqHz: F1 });
    expect(audioTo('a')).toEqual([false]);
    expect(audioTo('b')).toEqual([true]);
    expect(excludesTo('a')).toEqual([[F1]]);
  });

  it('treats frequencies within a channel width as the same signal', () => {
    c.onEvent('a', parked(F1, 30));
    sent = [];
    c.onEvent('b', parked(F1 + 5000, 20));
    expect(excludesTo('b')).toEqual([[F1 + 5000]]);
  });

  it('logs the signal once when both radios report it', () => {
    c.onEvent('a', hit(F1, 20));
    c.onEvent('a', parked(F1, 20));
    c.onEvent('b', hit(F1, 30));
    c.onEvent('b', parked(F1, 30));
    expect(log.rows()).toHaveLength(1);
    expect(log.rows()[0].count).toBe(1);
  });

  it('lets the losing radio find it again after the winner leaves', () => {
    c.onEvent('a', parked(F1, 30));
    c.onEvent('b', parked(F1, 20));
    sent = [];
    c.onEvent('a', released(F1));
    expect(excludesTo('b')).toEqual([[]]);
  });

  it('keeps the exclusion when the loser reports its own release', () => {
    c.onEvent('a', parked(F1, 30));
    c.onEvent('b', parked(F1, 20));
    sent = [];
    c.onEvent('b', released(F1));
    expect(excludesTo('b')).toEqual([]);
    expect(c.playing()).toEqual({ radioId: 'a', freqHz: F1 });
  });

  it('does not make a released loser the new player', () => {
    c.onEvent('a', parked(F1, 30));
    c.onEvent('b', parked(F1, 20));
    c.onEvent('b', released(F1));
    c.onEvent('a', released(F1));
    expect(c.playing()).toBeNull();
  });
});

describe('Coordinator: two radios looking for different things', () => {
  const parkedAs = (freqHz: number, mode: 'NFM' | 'APRS', snrDb: number): ScanEvent => ({
    type: 'parked',
    freqHz,
    mode,
    levelDb: -50,
    snrDb,
  });

  it('never turns an APRS radio away because an FM radio hears the frequency better', () => {
    c.onEvent('a', parkedAs(F1, 'NFM', 40));
    sent = [];
    c.onEvent('b', parkedAs(F1, 'APRS', 20));
    expect(excludesTo('b')).toEqual([]);
    expect(excludesTo('a')).toEqual([]);
    expect(c.liveFreqs()).toEqual([F1]);
  });
});

describe('Coordinator: different signals on two radios', () => {
  it('keeps playing the first and shows the second as live', () => {
    c.onEvent('a', parked(F1));
    sent = [];
    c.onEvent('b', parked(F2));
    expect(c.playing()).toEqual({ radioId: 'a', freqHz: F1 });
    expect(audioTo('b')).toEqual([]);
    expect(c.liveFreqs()).toEqual([F2]);
  });

  it('moves to the live signal when the playing one ends', () => {
    c.onEvent('a', parked(F1));
    c.onEvent('b', parked(F2));
    sent = [];
    c.onEvent('a', released(F1));
    expect(c.playing()).toEqual({ radioId: 'b', freqHz: F2 });
    expect(audioTo('b')).toEqual([true]);
    expect(c.liveFreqs()).toEqual([]);
  });

  it('clicking a live row switches the audio to it', () => {
    c.onEvent('a', parked(F1));
    c.onEvent('b', parked(F2));
    sent = [];
    c.select(F2);
    expect(c.playing()).toEqual({ radioId: 'b', freqHz: F2 });
    expect(audioTo('a')).toEqual([false]);
    expect(audioTo('b')).toEqual([true]);
    expect(c.liveFreqs()).toEqual([F1]);
  });

  it('clicking a row that is not on the air changes nothing', () => {
    c.onEvent('a', parked(F1));
    sent = [];
    c.select(F2);
    expect(c.playing()).toEqual({ radioId: 'a', freqHz: F1 });
    expect(sent).toEqual([]);
  });

  it('leaves the switched-away radio parked until its own signal ends', () => {
    c.onEvent('a', parked(F1));
    c.onEvent('b', parked(F2));
    sent = [];
    c.select(F2);
    expect(sent.filter((s) => s.cmd.type === 'next')).toEqual([]);
  });
});

describe('Coordinator: Skip and Next', () => {
  it('tells every radio about a skip and saves the row', () => {
    c.onEvent('a', hit(F1));
    saved = [];
    c.skip(F1);
    expect(skipsTo('a')).toEqual([[F1]]);
    expect(skipsTo('b')).toEqual([[F1]]);
    expect(log.rows()[0].skipped).toBe(true);
    expect(saved).toHaveLength(1);
  });

  it('lifts the skip everywhere on Unskip', () => {
    c.onEvent('a', hit(F1));
    c.skip(F1);
    sent = [];
    c.unskip(F1);
    expect(skipsTo('a')).toEqual([[]]);
    expect(skipsTo('b')).toEqual([[]]);
  });

  it('gives a newly added radio the skip list', () => {
    c.onEvent('a', hit(F1));
    c.skip(F1);
    sent = [];
    c.addRadio('c', 'Another');
    expect(skipsTo('c')).toEqual([[F1]]);
  });

  it('Next goes to the playing radio only', () => {
    c.onEvent('a', parked(F1));
    c.onEvent('b', parked(F2));
    sent = [];
    c.next();
    expect(sent).toEqual([{ radioId: 'a', cmd: { type: 'next' } }]);
  });

  it('Next with nothing playing does nothing', () => {
    c.next();
    expect(sent).toEqual([]);
  });
});

describe('Coordinator: radios going away', () => {
  it('moves on when the playing radio is stopped or removed', () => {
    c.onEvent('a', parked(F1));
    c.onEvent('b', parked(F2));
    sent = [];
    c.radioStopped('a');
    expect(c.playing()).toEqual({ radioId: 'b', freqHz: F2 });
    expect(audioTo('b')).toEqual([true]);
  });

  it('lifts exclusions a removed radio was the reason for', () => {
    c.onEvent('a', parked(F1, 30));
    c.onEvent('b', parked(F1, 20));
    sent = [];
    c.radioStopped('a');
    expect(excludesTo('b')).toEqual([[]]);
  });

  it('forgets a removed radio so it gets no more commands', () => {
    c.removeRadio('b');
    sent = [];
    c.onEvent('a', hit(F1));
    c.skip(F1);
    expect(sent.filter((s) => s.radioId === 'b')).toEqual([]);
  });
});

describe('Coordinator: APRS packets', () => {
  const packetEvent = (source: string): ScanEvent => ({
    type: 'packet',
    freqHz: 144_390_000,
    levelDb: -60,
    snrDb: 25,
    packet: parseAprs({ source, destination: 'APRS', path: [], info: '>x' }),
  });

  it('stores the packet with its metadata and updates the row', () => {
    c.onEvent('a', { type: 'hit', freqHz: 144_390_000, mode: 'APRS', levelDb: -60, snrDb: 25, stopped: true });
    saved = [];
    time = 5000;
    c.onEvent('a', packetEvent('KE5ABC-9'));
    const stored = saved.find((x) => 'packet' in (x as object));
    expect(stored).toMatchObject({ freqHz: 144_390_000, at: 5000, levelDb: -60, snrDb: 25, radioName: 'RTL-SDR' });
    expect(log.rows()[0]).toMatchObject({ packetCount: 1, latestStation: 'KE5ABC-9' });
  });

  it('files a packet under its row when it landed one channel step away', () => {
    c.onEvent('a', { type: 'hit', freqHz: 144_390_000, mode: 'APRS', levelDb: -60, snrDb: 25, stopped: true });
    saved = [];
    c.onEvent('a', { ...packetEvent('KE5ABC-9'), freqHz: 144_395_000 } as ScanEvent);
    const stored = saved.find((x) => 'packet' in (x as object));
    expect(stored).toMatchObject({ freqHz: 144_390_000 });
  });

  it('tells listeners about each new packet', () => {
    const seen: string[] = [];
    c.onPacket((p) => seen.push(p.packet.source));
    c.onEvent('a', packetEvent('W5WX-13'));
    expect(seen).toEqual(['W5WX-13']);
  });
});
