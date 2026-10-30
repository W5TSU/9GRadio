import type { Scanner } from '../app/scanner';
import { h, setText } from './dom';
import { fmtMhz, fmtStay } from './format';

const SNR_FULL_SCALE_DB = 60;

/** The bar across the top: what is playing, how long it stays, and the manual exits. */
export class NowPlaying {
  readonly element: HTMLElement;
  private readonly title = h('span', { class: 'dim' }, 'Nothing playing');
  private readonly freq = h('span', { class: 'big' });
  private readonly mode = h('span', { class: 'pill' });
  private readonly meterFill = h('i');
  private readonly level = h('span', { class: 'mono' });
  private readonly radio = h('span', { class: 'dim' });
  private readonly stay = h('span', { class: 'dim' });
  private readonly skip = h('button', null, 'Skip this frequency');
  private readonly next = h('button', null, 'Next ▸');
  private readonly details: HTMLElement;

  constructor(private readonly scanner: Scanner) {
    this.skip.onclick = () => {
      const p = scanner.coordinator.playing();
      if (p) scanner.coordinator.skip(p.freqHz);
    };
    this.next.onclick = () => scanner.coordinator.next();
    this.details = h(
      'span',
      null,
      h('span', { class: 'meter' }, this.meterFill),
      ' ',
      this.level,
    );
    this.element = h(
      'section',
      { class: 'box nowplaying' },
      this.title,
      this.freq,
      this.mode,
      this.details,
      this.radio,
      this.stay,
      h('span', { class: 'spacer' }),
      this.skip,
      this.next,
    );
    this.render();
  }

  render() {
    const { coordinator, radios, log } = this.scanner;
    const playing = coordinator.playing();
    const on = !!playing;
    this.element.classList.toggle('on', on);
    this.skip.disabled = !on;
    this.next.disabled = !on;
    for (const el of [this.freq, this.mode, this.details, this.radio, this.stay]) el.hidden = !on;

    if (!playing) {
      this.title.className = 'dim';
      setText(this.title, radios.size ? 'Nothing playing' : 'Add a radio to begin');
      return;
    }
    this.title.className = 'ok';
    setText(this.title, '▶ Now playing');

    const handle = radios.get(playing.radioId);
    const status = handle?.status;
    const row = log.find(playing.freqHz);
    setText(this.freq, '');
    this.freq.append(fmtMhz(playing.freqHz), h('small', null, ' MHz'));
    setText(this.mode, row?.mode ?? '');
    setText(this.radio, handle?.info?.name ?? '');

    const snr = status?.snrDb ?? row?.snrDb;
    const level = status?.levelDb ?? row?.levelDb;
    this.meterFill.style.width = `${Math.max(0, Math.min(100, ((snr ?? 0) / SNR_FULL_SCALE_DB) * 100))}%`;
    setText(this.level, snr === undefined || level === undefined ? '' : `${snr.toFixed(0)} dB over noise · ${level.toFixed(0)} dBFS`);
    setText(this.stay, status?.stop ? fmtStay(status.stop, status.remainingMs ?? 0, !!status.signalOn) : '');
  }
}
