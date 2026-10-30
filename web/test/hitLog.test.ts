import { describe, expect, it } from 'vitest';
import { HitLog } from '../src/app/hitLog';
import { hitsToCsv, packetsToCsv } from '../src/app/csv';
import { parseAprs } from '../src/decoders/aprs';

const hit = (freqHz: number, at: number, over = {}) => ({
  freqHz,
  mode: 'NFM' as const,
  levelDb: -50,
  snrDb: 30,
  radioName: 'RTL-SDR',
  at,
  ...over,
});

describe('HitLog', () => {
  it('adds one row per found frequency', () => {
    const log = new HitLog();
    log.recordHit(hit(146_520_000, 1000));
    log.recordHit(hit(146_940_000, 2000));
    expect(log.rows().map((r) => r.freqHz)).toEqual([146_940_000, 146_520_000]);
  });

  it('treats a hit within a channel width as the same row', () => {
    const log = new HitLog();
    log.recordHit(hit(146_520_000, 1000));
    log.recordHit(hit(146_525_000, 90_000));
    expect(log.rows()).toHaveLength(1);
    expect(log.rows()[0].freqHz).toBe(146_520_000);
  });

  it('keeps neighbouring channels on their own rows', () => {
    const log = new HitLog();
    log.recordHit(hit(146_520_000, 1000));
    log.recordHit(hit(146_535_000, 2000));
    expect(log.rows()).toHaveLength(2);
  });

  it('counts a new hit once the signal has been gone a while, and updates the row', () => {
    const log = new HitLog();
    log.recordHit(hit(146_520_000, 1000));
    log.recordHit(hit(146_520_000, 60_000, { levelDb: -40, snrDb: 40, radioName: 'HackRF' }));
    const [r] = log.rows();
    expect(r.count).toBe(2);
    expect(r.firstHeard).toBe(1000);
    expect(r.lastHeard).toBe(60_000);
    expect(r.levelDb).toBe(-40);
    expect(r.radioName).toBe('HackRF');
  });

  it('does not count again while the signal is still being heard', () => {
    const log = new HitLog();
    log.recordHit(hit(146_520_000, 1000));
    log.recordHit(hit(146_520_000, 3000));
    log.touch(146_520_000, -45, 35, 20_000);
    log.recordHit(hit(146_520_000, 22_000));
    expect(log.rows()[0].count).toBe(1);
  });

  it('marks and unmarks a frequency as skipped', () => {
    const log = new HitLog();
    log.recordHit(hit(146_520_000, 1000));
    log.setSkipped(146_520_000, true);
    expect(log.skippedFreqs()).toEqual([146_520_000]);
    expect(log.rows()[0].skipped).toBe(true);
    log.setSkipped(146_520_000, false);
    expect(log.skippedFreqs()).toEqual([]);
  });

  it('keeps a skip when the same frequency is logged again', () => {
    const log = new HitLog();
    log.recordHit(hit(146_520_000, 1000));
    log.setSkipped(146_520_000, true);
    log.recordHit(hit(146_520_000, 90_000));
    expect(log.rows()[0].skipped).toBe(true);
  });

  it('counts packets and remembers the latest station', () => {
    const log = new HitLog();
    log.recordHit(hit(144_390_000, 1000, { mode: 'APRS' }));
    log.recordPacket(144_390_000, 'KE5ABC-9', 2000);
    log.recordPacket(144_390_000, 'W5WX-13', 3000);
    const [r] = log.rows();
    expect(r.packetCount).toBe(2);
    expect(r.latestStation).toBe('W5WX-13');
    expect(r.lastHeard).toBe(3000);
  });

  it('keeps a row that has packets as APRS when a voice radio also hears it', () => {
    const log = new HitLog();
    log.recordHit(hit(144_390_000, 1000, { mode: 'APRS' }));
    log.recordPacket(144_390_000, 'KE5ABC-9', 2000);
    log.recordHit(hit(144_390_000, 90_000, { mode: 'NFM' }));
    expect(log.rows()[0].mode).toBe('APRS');
  });

  it('lets a row with no packets take the mode of the latest hit', () => {
    const log = new HitLog();
    log.recordHit(hit(144_390_000, 1000, { mode: 'NFM' }));
    log.recordHit(hit(144_390_000, 90_000, { mode: 'APRS' }));
    expect(log.rows()[0].mode).toBe('APRS');
  });

  it('restores saved rows', () => {
    const first = new HitLog();
    first.recordHit(hit(146_520_000, 1000));
    first.setSkipped(146_520_000, true);
    const second = new HitLog(first.rows());
    expect(second.skippedFreqs()).toEqual([146_520_000]);
  });

  it('removes everything but the skips when cleared', () => {
    const log = new HitLog();
    log.recordHit(hit(146_520_000, 1000));
    log.recordHit(hit(146_940_000, 2000));
    log.setSkipped(146_940_000, true);
    log.clearUnskipped();
    expect(log.rows().map((r) => r.freqHz)).toEqual([146_940_000]);
  });
});

describe('CSV export', () => {
  const log = new HitLog();
  log.recordHit(hit(146_520_000, Date.UTC(2026, 9, 30, 14, 32, 5), { levelDb: -71.26, snrDb: 30.5 }));
  const rows = log.rows();

  it('writes one line per hit under a header', () => {
    const lines = hitsToCsv(rows).trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('frequency_mhz,mode,hits,skipped,first_heard,last_heard,level_dbfs,snr_db,radio,packets,latest_station');
    expect(lines[1]).toBe(
      '146.520000,NFM,1,no,2026-10-30T14:32:05.000Z,2026-10-30T14:32:05.000Z,-71.3,30.5,RTL-SDR,0,',
    );
  });

  const packet = (info: string) => ({
    freqHz: 144_390_000,
    at: Date.UTC(2026, 9, 30, 14, 32, 5),
    levelDb: -60,
    snrDb: 25,
    radioName: 'RTL-SDR',
    packet: parseAprs({ source: 'KE5ABC-9', destination: 'APDR16', path: ['WIDE2-1'], info }),
  });

  it('writes the metadata and decoded fields for a packet', () => {
    const lines = packetsToCsv([packet('=3528.46N/09730.12W>270/042 Hi')]).trim().split('\r\n');
    const header = lines[0].split(',');
    const cells = lines[1].split(',');
    const at = (name: string) => cells[header.indexOf(name)];
    expect(at('from')).toBe('KE5ABC-9');
    expect(at('type')).toBe('Position');
    expect(at('latitude')).toBe('35.474333');
    expect(at('longitude')).toBe('-97.502000');
    expect(at('course_deg')).toBe('270');
    expect(at('speed_knots')).toBe('42.0');
    expect(at('comment')).toBe('Hi');
    expect(at('frequency_mhz')).toBe('144.390000');
  });

  it('quotes cells holding commas, quotes and line breaks', () => {
    const csv = packetsToCsv([packet('>a,"b"\nc')]);
    expect(csv).toContain('"a,""b""\nc"');
  });

  it('stops a transmitted comment from running as a spreadsheet formula', () => {
    for (const evil of ['=cmd()', '+1+1', '-2+3', '@SUM(1)']) {
      const csv = packetsToCsv([packet(`>${evil}`)]);
      expect(csv).toContain(`'${evil}`);
    }
  });

  it('protects the raw packet text as well', () => {
    const p = packet('>x');
    p.packet = { ...p.packet, raw: '=HYPERLINK("http://bad")' };
    expect(packetsToCsv([p])).toContain(`"'=HYPERLINK(""http://bad"")"`);
  });
});
