import { CHANNEL_WIDTH_HZ, type Mode } from '../dsp/demod';
import type { RadioHandle, Scanner } from '../app/scanner';
import type { RadioSettings } from '../app/settings';
import { h, setText } from './dom';
import { BAND_PRESETS, bandProblem, fmtMhz } from './format';
import { Waterfall } from './waterfall';

const MODES: { mode: Mode; label: string }[] = [
  { mode: 'NFM', label: 'NFM' },
  { mode: 'AM', label: 'AM' },
  { mode: 'WFM', label: 'WFM' },
  { mode: 'USB', label: 'USB' },
  { mode: 'LSB', label: 'LSB' },
  { mode: 'CW', label: 'CW' },
  { mode: 'APRS', label: 'APRS' },
];

const MAX_FOUND_MARKS = 8;

function numberInput(value: number, step: number, onChange: (v: number) => void, className = '') {
  const input = h('input', { type: 'number', value: String(value), step: String(step), class: className });
  input.onchange = () => onChange(parseFloat(input.value));
  return input;
}

/** One radio on screen: its controls, status and waterfall. */
export class RadioPanel {
  readonly element: HTMLElement;
  private readonly waterfall = new Waterfall();
  private readonly stateLabel = h('span', { class: 'spacer' });
  private readonly nameLabel = h('b');
  private readonly detailLabel = h('span', { class: 'dim mono' });
  private readonly dot = h('span', { class: 'dim' }, '●');
  private readonly startButton = h('button', { class: 'primary' }, 'Start');
  private readonly problem = h('div', { class: 'radio-problem' });
  private readonly marks = h('div', { class: 'marks' });
  private readonly axis = h('div', { class: 'axis' });
  private readonly controls = h('div', { class: 'radio-controls' });
  private inputs: Partial<Record<'start' | 'stop' | 'step', HTMLInputElement>> = {};
  private modeSelect: HTMLSelectElement | null = null;
  private presetSelect: HTMLSelectElement | null = null;
  private strongLabel = h('span', { class: 'mono' });
  private built = false;
  private bandKey = '';

  constructor(
    private readonly scanner: Scanner,
    private readonly handle: RadioHandle,
  ) {
    const remove = h('button', { title: 'Remove this radio', onclick: () => this.scanner.removeRadio(this.handle) }, '✕');
    this.startButton.onclick = () => this.toggle();
    this.element = h(
      'section',
      { class: 'box' },
      h('div', { class: 'radio-head' }, this.dot, this.nameLabel, this.detailLabel, this.stateLabel, this.startButton, remove),
      this.controls,
      this.problem,
      this.marks,
      this.waterfall.element,
      this.axis,
    );
    this.render();
  }

  onSpectrum(startHz: number, binHz: number, db: Float32Array, floorDb: number, thresholdDb: number) {
    this.waterfall.onSpectrum(startHz, binHz, db, floorDb, thresholdDb);
  }

  tick() {
    this.waterfall.tick();
  }

  render() {
    const { handle } = this;
    setText(this.nameLabel, handle.info?.name ?? (handle.error ? 'Radio' : 'Connecting…'));
    setText(this.detailLabel, this.details());
    if (handle.info && !this.built) this.buildControls();

    const problem = handle.info ? bandProblem(handle.settings, handle.info) : null;
    setText(this.problem, handle.error ?? problem ?? '');
    this.problem.hidden = !handle.error && !problem;

    this.startButton.textContent = handle.running ? 'Stop' : 'Start';
    this.startButton.disabled = !handle.info || (!handle.running && problem !== null);
    this.startButton.className = handle.running ? '' : 'primary';

    this.renderState();
    if (handle.info) {
      this.renderAxis();
      this.renderMarks();
    }
  }

  private details() {
    const i = this.handle.info;
    if (!i) return '';
    if (i.kind === 'demo') return 'simulated signals, not real reception';
    return [i.tuner, i.serial && `SN ${i.serial}`, `${(i.sampleRate / 1e6).toFixed(1)} MS/s`].filter(Boolean).join(' · ');
  }

  private renderState() {
    const { status, running, id } = this.handle;
    const playing = this.scanner.coordinator.playing();
    let text = 'Stopped';
    let cls = 'dim';
    if (running) {
      if (status.phase === 'parked' && status.freqHz !== undefined) {
        const on = playing?.radioId === id;
        text = `${on ? 'Playing' : 'Live'} ${fmtMhz(status.freqHz)}`;
        cls = on ? 'ok' : 'live';
      } else if (status.phase === 'probing' && status.freqHz !== undefined) {
        text = `Checking ${fmtMhz(status.freqHz)} for APRS`;
        cls = 'acc';
      } else {
        text = 'Scanning';
        cls = 'acc';
      }
    }
    setText(this.stateLabel, text);
    this.stateLabel.className = `spacer ${cls}`;
    this.dot.className = running ? 'ok' : 'dim';
  }

  private toggle() {
    if (this.handle.running) {
      this.scanner.stop(this.handle);
    } else {
      this.applyBandToWaterfall();
      this.scanner.start(this.handle);
    }
  }

  private buildControls() {
    this.built = true;
    const { handle, scanner } = this;
    const s = handle.settings;

    this.presetSelect = h(
      'select',
      { onchange: () => this.applyPreset() },
      h('option', { value: '' }, 'Custom band'),
      ...BAND_PRESETS.map((p, i) => h('option', { value: String(i) }, p.name)),
    );
    this.inputs.start = numberInput(s.startHz / 1e6, 0.001, (v) => this.updateBand({ startHz: Math.round(v * 1e6) }));
    this.inputs.stop = numberInput(s.stopHz / 1e6, 0.001, (v) => this.updateBand({ stopHz: Math.round(v * 1e6) }));
    this.inputs.step = numberInput(s.stepHz / 1e3, 0.1, (v) => this.updateBand({ stepHz: Math.round(v * 1e3) }), 'short');
    this.modeSelect = h(
      'select',
      { onchange: () => this.updateBand({ mode: this.modeSelect!.value as Mode }) },
      ...MODES.map(({ mode, label }) => h('option', { value: mode }, label)),
    );
    this.modeSelect.value = s.mode;
    this.syncPreset();

    setText(this.strongLabel, `noise + ${s.marginDb} dB`);
    const strong = h('input', { type: 'range', min: '3', max: '40', step: '1', value: String(s.marginDb) });
    strong.oninput = () => {
      s.marginDb = Number(strong.value);
      setText(this.strongLabel, `noise + ${s.marginDb} dB`);
      this.waterfall.previewMargin(s.marginDb);
      scanner.sendTiming(handle);
    };

    const n = numberInput(s.minStayS, 1, (v) => {
      s.minStayS = Math.max(0, v || 0);
      scanner.sendTiming(handle);
    }, 'short');
    const x = numberInput(s.delayS, 1, (v) => {
      s.delayS = Math.max(0, v || 0);
      scanner.sendTiming(handle);
    }, 'short');

    const gainLabel = h('span', { class: 'mono' }, `${s.gainDb} dB`);
    const gain = h('input', { type: 'range', min: '0', max: String(handle.info!.maxGainDb), step: '1', value: String(s.gainDb) });
    gain.oninput = () => {
      s.gainDb = Number(gain.value);
      setText(gainLabel, `${s.gainDb} dB`);
      handle.post({ type: 'gain', db: s.gainDb });
      scanner.saveSettings(handle);
    };
    const ppm = numberInput(s.ppm, 1, (v) => {
      s.ppm = v || 0;
      handle.post({ type: 'ppm', ppm: s.ppm });
      scanner.saveSettings(handle);
    }, 'short');

    this.controls.append(
      this.presetSelect,
      h('label', null, 'Start', this.inputs.start, 'MHz'),
      h('label', null, 'Stop', this.inputs.stop, 'MHz'),
      h('label', null, 'Step', this.inputs.step, 'kHz'),
      h('label', null, 'Looking for', this.modeSelect),
      h('label', { title: 'A signal must clear this line to stop the scan' }, 'Strong', strong, this.strongLabel),
      h('label', { title: 'n: the shortest it stays after stopping' }, 'Stay at least', n, 's'),
      h('label', { title: 'x: how long it waits for a reply after the signal drops' }, 'Reply delay', x, 's'),
      h('label', null, 'Gain', gain, gainLabel),
      h('label', { title: 'Corrects for an off-frequency crystal' }, 'PPM', ppm),
    );
    this.applyBandToWaterfall();
  }

  private applyPreset() {
    const preset = BAND_PRESETS[Number(this.presetSelect!.value)];
    if (!this.presetSelect!.value || !preset) return;
    const { startHz, stopHz, stepHz, mode } = preset;
    this.inputs.start!.value = String(startHz / 1e6);
    this.inputs.stop!.value = String(stopHz / 1e6);
    this.inputs.step!.value = String(stepHz / 1e3);
    this.modeSelect!.value = mode;
    this.updateBand({ startHz, stopHz, stepHz, mode });
  }

  private syncPreset() {
    const s = this.handle.settings;
    const index = BAND_PRESETS.findIndex((p) => p.startHz === s.startHz && p.stopHz === s.stopHz && p.stepHz === s.stepHz && p.mode === s.mode);
    this.presetSelect!.value = index >= 0 ? String(index) : '';
  }

  /** A band or mode change takes effect at once, restarting the scan if it is running. */
  private updateBand(change: Partial<RadioSettings>) {
    const { handle, scanner } = this;
    Object.assign(handle.settings, change);
    this.syncPreset();
    scanner.saveSettings(handle);
    const problem = bandProblem(handle.settings, handle.info!);
    if (!problem) {
      this.applyBandToWaterfall();
      if (handle.running) {
        scanner.coordinator.radioStopped(handle.id);
        scanner.start(handle);
      }
    } else if (handle.running) {
      scanner.stop(handle);
    }
    this.render();
  }

  private applyBandToWaterfall() {
    const s = this.handle.settings;
    const key = `${s.startHz}-${s.stopHz}`;
    if (key !== this.bandKey) {
      this.bandKey = key;
      this.waterfall.setBand(s.startHz, s.stopHz);
    }
  }

  private renderAxis() {
    const s = this.handle.settings;
    if (this.axis.dataset.band === this.bandKey) return;
    this.axis.dataset.band = this.bandKey;
    this.axis.replaceChildren(
      ...[0, 0.25, 0.5, 0.75, 1].map((f) => h('span', null, ((s.startHz + (s.stopHz - s.startHz) * f) / 1e6).toFixed(3))),
    );
  }

  private renderMarks() {
    const s = this.handle.settings;
    const { coordinator, log } = this.scanner;
    const playing = coordinator.playing();
    const live = coordinator.liveFreqs();
    const width = s.stopHz - s.startHz;
    const rows = log.rows().filter((r) => r.freqHz >= s.startHz && r.freqHz <= s.stopHz);
    const near = (a: number, b: number, mode: Mode) => Math.abs(a - b) < CHANNEL_WIDTH_HZ[mode] / 2;

    let found = 0;
    const marks: HTMLElement[] = [];
    for (const r of rows) {
      const isPlaying = playing && near(playing.freqHz, r.freqHz, r.mode);
      const isLive = live.some((f) => near(f, r.freqHz, r.mode));
      if (!isPlaying && !isLive && !r.skipped && found++ >= MAX_FOUND_MARKS) continue;
      const symbol = isPlaying ? '▶ ' : isLive ? '◉ ' : r.skipped ? '⊘ ' : '';
      const cls = isPlaying ? 'ok' : isLive ? 'live' : r.skipped ? 'skipped' : 'found';
      const span = h('span', { class: cls, title: `${fmtMhz(r.freqHz)} MHz` }, `${symbol}${fmtMhz(r.freqHz)}`);
      span.style.left = `${Math.max(3, Math.min(97, ((r.freqHz - s.startHz) / width) * 100))}%`;
      marks.push(span);
    }
    this.marks.replaceChildren(...marks);
  }
}
