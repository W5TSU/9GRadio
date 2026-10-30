import { packetsToCsv, type PacketRecord } from '../app/csv';
import type { HitRow } from '../app/hitLog';
import type { Scanner } from '../app/scanner';
import type { AprsPacket, AprsWeather } from '../decoders/aprs';
import { download, h, setText } from './dom';
import { fmtClock, fmtMhz } from './format';

const PAGE = 100;
const KNOTS_TO_MPH = 1.15078;

function hemi(value: number, positive: string, negative: string) {
  return `${Math.abs(value).toFixed(4)}° ${value >= 0 ? positive : negative}`;
}

function weatherText(w: AprsWeather): string {
  const parts: string[] = [];
  if (w.tempF !== undefined) parts.push(`${w.tempF} °F`);
  if (w.windMph !== undefined) {
    parts.push(`wind ${w.windDirDeg ?? '?'}° at ${w.windMph} mph${w.gustMph !== undefined ? ` (gust ${w.gustMph})` : ''}`);
  }
  if (w.humidityPct !== undefined) parts.push(`humidity ${w.humidityPct} %`);
  if (w.pressureMb !== undefined) parts.push(`${w.pressureMb.toFixed(1)} mb`);
  return parts.join(', ');
}

/** The one-line summary shown on a closed packet. */
function summary(p: AprsPacket): string {
  const bits: string[] = [`${p.source} → ${p.destination}`, p.type];
  if (p.objectName) bits.push(p.objectName);
  if (p.weather) bits.push(weatherText(p.weather));
  if (p.message) bits.push(`to ${p.message.to}: "${p.message.text}"`);
  else if (p.comment) bits.push(p.comment);
  return bits.join(' · ');
}

/** The rows of decoded data on an open packet. */
function decodedFields(p: AprsPacket): [string, string][] {
  const f: [string, string][] = [
    ['From', p.source],
    ['To', p.destination],
    ['Path', p.path.join(', ') || 'direct'],
    ['Type', p.type],
  ];
  if (p.objectName) f.push(['Name', p.objectName]);
  if (p.latitude !== undefined && p.longitude !== undefined) {
    f.push(['Position', `${hemi(p.latitude, 'N', 'S')}, ${hemi(p.longitude, 'E', 'W')}`]);
  }
  if (p.courseDeg !== undefined && p.speedKnots !== undefined) {
    f.push(['Course / speed', `${p.courseDeg}° / ${p.speedKnots.toFixed(0)} kt (${(p.speedKnots * KNOTS_TO_MPH).toFixed(0)} mph)`]);
  }
  if (p.altitudeFt !== undefined) f.push(['Altitude', `${p.altitudeFt} ft`]);
  if (p.weather) f.push(['Weather', weatherText(p.weather)]);
  if (p.message) {
    f.push(['Message to', p.message.to], ['Text', p.message.text]);
    if (p.message.id) f.push(['Message ID', p.message.id]);
  }
  if (p.comment) f.push([p.type === 'Status' ? 'Status' : 'Comment', p.comment]);
  return f;
}

/** Every packet heard on one frequency, newest first, each one openable. */
export class PacketsPanel {
  readonly element = h('section', { class: 'box' });
  private readonly list = h('div');
  private readonly heading = h('span', { class: 'dim' });
  private readonly more = h('button', null, 'Show more');
  private records: PacketRecord[] = [];
  private row: HitRow | null = null;
  private shown = PAGE;
  private readonly opened = new WeakSet<PacketRecord>();

  constructor(private readonly scanner: Scanner) {
    this.more.onclick = () => {
      this.shown += PAGE;
      this.renderList();
    };
    this.element.hidden = true;
    scanner.coordinator.onPacket((record) => this.addLive(record));
  }

  async show(row: HitRow | null) {
    this.row = row;
    this.shown = PAGE;
    this.element.hidden = !row || row.mode !== 'APRS';
    if (this.element.hidden || !row) return;

    this.element.replaceChildren(
      h(
        'div',
        { class: 'packets-head' },
        h('b', { class: 'mono' }, `${fmtMhz(row.freqHz)} MHz`),
        h('span', { class: 'pill' }, row.mode),
        this.heading,
        h('span', { class: 'spacer' }),
        h('button', { onclick: () => this.exportCsv() }, 'Export CSV'),
        h('button', { title: 'Close', onclick: () => void this.show(null) }, '✕'),
      ),
      this.list,
      this.more,
    );
    this.records = await this.scanner.packetsFor(row.freqHz);
    this.renderList();
  }

  private addLive(record: PacketRecord) {
    if (!this.row || record.freqHz !== this.row.freqHz) return;
    this.records.unshift(record);
    this.renderList();
  }

  private renderList() {
    const { records } = this;
    const stations = new Set(records.map((r) => r.packet.source)).size;
    const newest = records[0];
    const oldest = records[records.length - 1];
    setText(
      this.heading,
      records.length
        ? `${records.length} packets · ${stations} stations · first heard ${fmtClock(oldest.at)} · last ${fmtClock(newest.at)}`
        : 'No packets yet',
    );
    this.more.hidden = records.length <= this.shown;
    this.list.replaceChildren(...records.slice(0, this.shown).map((r, i) => this.renderPacket(r, i === 0 || this.opened.has(r))));
  }

  private renderPacket(r: PacketRecord, open: boolean): HTMLElement {
    const meta = h(
      'div',
      { class: 'meta' },
      h('span', null, h('b', { class: 'mono' }, fmtClock(r.at))),
      h('span', null, 'Freq ', h('b', { class: 'mono' }, fmtMhz(r.freqHz))),
      h('span', null, 'Signal ', h('b', { class: 'mono' }, `${r.snrDb.toFixed(0)} dB over noise · ${r.levelDb.toFixed(0)} dBFS`)),
      h('span', null, 'Radio ', h('b', null, r.radioName)),
      h('span', null, 'CRC ', h('b', { class: 'ok' }, 'OK')),
    );
    const box = h('div', { class: open ? 'pkt open' : 'pkt' }, meta);
    if (open) {
      box.append(this.fullDetail(r));
    } else {
      box.append(h('div', { class: 'mono' }, summary(r.packet)));
      box.onclick = () => {
        this.opened.add(r);
        box.className = 'pkt open';
        box.onclick = null;
        box.lastElementChild!.remove();
        box.append(this.fullDetail(r));
      };
    }
    return box;
  }

  private fullDetail(r: PacketRecord): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const kv = h('div', { class: 'kv' });
    for (const [key, value] of decodedFields(r.packet)) {
      kv.append(h('span', { class: 'k' }, key), h('span', null, value));
    }
    fragment.append(kv, h('div', { class: 'raw' }, r.packet.raw));
    return fragment;
  }

  private exportCsv() {
    if (!this.row) return;
    download(`9gradio-packets-${fmtMhz(this.row.freqHz)}-${new Date().toISOString().slice(0, 10)}.csv`, packetsToCsv(this.records));
  }
}
