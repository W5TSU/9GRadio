import { hitsToCsv } from '../app/csv';
import type { HitRow } from '../app/hitLog';
import type { Scanner } from '../app/scanner';
import { download, h, setText } from './dom';
import { fmtClock, fmtMhz } from './format';

type Tab = 'all' | 'live' | 'skipped';

interface RowView {
  tr: HTMLTableRowElement;
  freq: HTMLTableCellElement;
  mode: HTMLTableCellElement;
  latest: HTMLTableCellElement;
  hits: HTMLTableCellElement;
  last: HTMLTableCellElement;
  button: HTMLButtonElement;
}

/**
 * The right-hand list. Rows are kept and updated in place: replacing them on each
 * refresh would lose a click made while a refresh happened.
 */
export class HitList {
  readonly element: HTMLElement;
  private readonly body = h('tbody');
  private readonly empty = h('div', { class: 'empty' }, 'Signals the scanner finds will appear here.');
  private readonly tabLinks: Record<Tab, HTMLAnchorElement>;
  private readonly views = new Map<number, RowView>();
  private tab: Tab = 'all';
  private selectedFreq: number | null = null;

  constructor(
    private readonly scanner: Scanner,
    private readonly onSelect: (row: HitRow | null) => void,
  ) {
    const tabLink = (tab: Tab) => {
      const a = h('a', {
        onclick: () => {
          this.tab = tab;
          this.render();
        },
      });
      return a;
    };
    this.tabLinks = { all: tabLink('all'), live: tabLink('live'), skipped: tabLink('skipped') };
    const table = h(
      'table',
      null,
      h(
        'thead',
        null,
        h('tr', null, h('th', null, 'Freq'), h('th', null, 'Mode'), h('th', null, 'Latest'), h('th', null, 'Hits'), h('th', null, 'Last'), h('th')),
      ),
      this.body,
    );
    this.element = h(
      'aside',
      { class: 'box right' },
      h(
        'div',
        { class: 'tabs' },
        this.tabLinks.all,
        this.tabLinks.live,
        this.tabLinks.skipped,
        h('span', { class: 'spacer' }),
        h('button', { title: 'Download this list', onclick: () => this.exportCsv() }, 'Export CSV'),
        h('button', { title: 'Empty the list. Skips are kept.', onclick: () => void scanner.clearList() }, 'Clear'),
      ),
      table,
      this.empty,
    );
    this.render();
  }

  get selected() {
    return this.selectedFreq === null ? undefined : this.scanner.log.find(this.selectedFreq);
  }

  render() {
    const { coordinator, log } = this.scanner;
    const rows = log.rows();
    if (this.selectedFreq !== null && !this.selected) {
      this.selectedFreq = null;
      this.onSelect(null);
    }
    const playing = coordinator.playing();
    const playingRow = playing && log.find(playing.freqHz);
    const liveRows = new Set(coordinator.liveFreqs().map((f) => log.find(f)));

    setText(this.tabLinks.all, `All (${rows.length})`);
    setText(this.tabLinks.live, `Live (${liveRows.size + (playingRow ? 1 : 0)})`);
    setText(this.tabLinks.skipped, `Skipped (${rows.filter((r) => r.skipped).length})`);
    for (const [tab, link] of Object.entries(this.tabLinks)) link.className = tab === this.tab ? 'on' : '';

    const visible = rows.filter((r) => {
      if (this.tab === 'skipped') return r.skipped;
      if (this.tab === 'live') return r === playingRow || liveRows.has(r);
      return true;
    });

    const wanted = new Set(visible.map((r) => r.freqHz));
    for (const [freq, view] of this.views) {
      if (!wanted.has(freq)) {
        view.tr.remove();
        this.views.delete(freq);
      }
    }

    let previous: Element | null = null;
    for (const row of visible) {
      const view = this.views.get(row.freqHz) ?? this.createRow(row.freqHz);
      this.updateRow(view, row, row === playingRow, liveRows.has(row));
      // Only move a row when it is out of place.
      const expected: Element | null = previous ? previous.nextElementSibling : this.body.firstElementChild;
      if (expected !== view.tr) this.body.insertBefore(view.tr, expected);
      previous = view.tr;
    }
    this.empty.hidden = visible.length > 0;
  }

  private createRow(freqHz: number): RowView {
    const cell = () => h('td');
    const view: RowView = {
      tr: h('tr'),
      freq: h('td', { class: 'mono freq' }),
      mode: cell(),
      latest: h('td', { class: 'mono' }),
      hits: h('td', { class: 'mono' }),
      last: h('td', { class: 'mono dim' }),
      button: h('button'),
    };
    view.tr.onclick = () => this.select(freqHz);
    view.button.onclick = (e) => {
      e.stopPropagation();
      const row = this.scanner.log.find(freqHz);
      if (row?.skipped) this.scanner.coordinator.unskip(freqHz);
      else this.scanner.coordinator.skip(freqHz);
    };
    view.tr.append(view.freq, view.mode, view.latest, view.hits, view.last, h('td', { class: 'act' }, view.button));
    this.views.set(freqHz, view);
    return view;
  }

  private updateRow(v: RowView, r: HitRow, isPlaying: boolean, isLive: boolean) {
    const symbol = isPlaying ? '▶ ' : isLive ? '◉ ' : r.skipped ? '⊘ ' : '';
    setText(v.freq, `${symbol}${fmtMhz(r.freqHz)}`);
    v.freq.className = `mono freq ${isPlaying ? 'ok' : isLive ? 'live' : ''}`;
    setText(v.mode, r.mode);
    setText(v.latest, r.latestStation ? r.latestStation : `${r.snrDb.toFixed(0)} dB`);
    setText(v.hits, r.packetCount ? `${r.packetCount} pkts` : String(r.count));
    setText(v.last, fmtClock(r.lastHeard));
    setText(v.button, r.skipped ? 'Unskip' : 'Skip');
    v.tr.className = [isPlaying ? 'playing' : '', r.skipped ? 'skipped' : '', r.freqHz === this.selectedFreq ? 'sel' : ''].join(' ').trim();
  }

  private select(freqHz: number) {
    const row = this.scanner.log.find(freqHz) ?? null;
    this.selectedFreq = this.selectedFreq === freqHz ? null : freqHz;
    this.scanner.coordinator.select(freqHz);
    this.onSelect(this.selectedFreq === null ? null : row);
    this.render();
  }

  private exportCsv() {
    download(`9gradio-hits-${new Date().toISOString().slice(0, 10)}.csv`, hitsToCsv(this.scanner.log.rows()));
  }
}
