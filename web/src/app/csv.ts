import type { AprsPacket } from '../decoders/aprs';
import type { HitRow } from './hitLog';

export interface PacketRecord {
  id?: number;
  freqHz: number;
  at: number;
  levelDb: number;
  snrDb: number;
  radioName: string;
  packet: AprsPacket;
}

/**
 * For text that may have come over the air. A leading = + - @ would otherwise run
 * as a formula when the file is opened in a spreadsheet.
 */
function text(value: string | undefined): string {
  let v = value ?? '';
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

const num = (value: number | undefined, digits: number) => (value === undefined ? '' : value.toFixed(digits));
const whole = (value: number | undefined) => (value === undefined ? '' : String(value));
const mhz = (hz: number) => (hz / 1e6).toFixed(6);
const time = (ms: number) => new Date(ms).toISOString();
const lines = (rows: string[][]) => rows.map((r) => r.join(',')).join('\r\n') + '\r\n';

export function hitsToCsv(rows: HitRow[]): string {
  return lines([
    [
      'frequency_mhz',
      'mode',
      'hits',
      'skipped',
      'first_heard',
      'last_heard',
      'level_dbfs',
      'snr_db',
      'radio',
      'packets',
      'latest_station',
    ],
    ...rows.map((r) => [
      mhz(r.freqHz),
      r.mode,
      whole(r.count),
      r.skipped ? 'yes' : 'no',
      time(r.firstHeard),
      time(r.lastHeard),
      num(r.levelDb, 1),
      num(r.snrDb, 1),
      text(r.radioName),
      whole(r.packetCount),
      text(r.latestStation),
    ]),
  ]);
}

export function packetsToCsv(records: PacketRecord[]): string {
  return lines([
    [
      'time',
      'frequency_mhz',
      'level_dbfs',
      'snr_db',
      'radio',
      'from',
      'to',
      'path',
      'type',
      'latitude',
      'longitude',
      'symbol',
      'course_deg',
      'speed_knots',
      'altitude_ft',
      'comment',
      'object',
      'message_to',
      'message_text',
      'temp_f',
      'wind_dir_deg',
      'wind_mph',
      'gust_mph',
      'humidity_pct',
      'pressure_mb',
      'raw',
    ],
    ...records.map((r) => {
      const p = r.packet;
      const w = p.weather;
      return [
        time(r.at),
        mhz(r.freqHz),
        num(r.levelDb, 1),
        num(r.snrDb, 1),
        text(r.radioName),
        text(p.source),
        text(p.destination),
        text(p.path.join(' ')),
        text(p.type),
        num(p.latitude, 6),
        num(p.longitude, 6),
        text(p.symbol),
        whole(p.courseDeg),
        num(p.speedKnots, 1),
        whole(p.altitudeFt),
        text(p.comment),
        text(p.objectName),
        text(p.message?.to),
        text(p.message?.text),
        whole(w?.tempF),
        whole(w?.windDirDeg),
        whole(w?.windMph),
        whole(w?.gustMph),
        whole(w?.humidityPct),
        num(w?.pressureMb, 1),
        text(p.raw),
      ];
    }),
  ]);
}
