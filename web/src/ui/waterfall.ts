import { spectrumToColumns } from './format';

const COLUMNS = 1024;
const TRACE_HEIGHT = 128;
const FALL_HEIGHT = 96;
/** The colors span this many dB, starting a little below the noise floor. */
const COLOR_RANGE_DB = 45;
const COLOR_FLOOR_OFFSET_DB = 3;
const TRACE_BELOW_DB = 10;
const TRACE_RANGE_DB = 60;

function buildPalette(): Uint8ClampedArray {
  const stops: [number, number, number, number][] = [
    [0, 11, 26, 58],
    [0.3, 20, 70, 170],
    [0.55, 30, 170, 170],
    [0.75, 240, 200, 60],
    [0.9, 240, 110, 40],
    [1, 255, 240, 220],
  ];
  const palette = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    let s = 0;
    while (s < stops.length - 2 && x > stops[s + 1][0]) s++;
    const [x0, r0, g0, b0] = stops[s];
    const [x1, r1, g1, b1] = stops[s + 1];
    const f = (x - x0) / (x1 - x0);
    palette[i * 4] = r0 + (r1 - r0) * f;
    palette[i * 4 + 1] = g0 + (g1 - g0) * f;
    palette[i * 4 + 2] = b0 + (b1 - b0) * f;
    palette[i * 4 + 3] = 255;
  }
  return palette;
}
const PALETTE = buildPalette();

/** A live trace over a scrolling waterfall of one radio's whole band. */
export class Waterfall {
  readonly element: HTMLDivElement;
  private readonly trace: HTMLCanvasElement;
  private readonly fall: HTMLCanvasElement;
  private readonly traceCtx: CanvasRenderingContext2D;
  private readonly fallCtx: CanvasRenderingContext2D;
  private readonly row: ImageData;
  private readonly columns = new Float32Array(COLUMNS).fill(-200);
  private band = { startHz: 0, stopHz: 1 };
  private floorDb = -80;
  private thresholdDb = -68;
  private hasData = false;

  constructor() {
    this.trace = Object.assign(document.createElement('canvas'), { width: COLUMNS, height: TRACE_HEIGHT, className: 'trace' });
    this.fall = Object.assign(document.createElement('canvas'), { width: COLUMNS, height: FALL_HEIGHT, className: 'fall' });
    this.traceCtx = this.trace.getContext('2d')!;
    this.fallCtx = this.fall.getContext('2d')!;
    this.row = this.fallCtx.createImageData(COLUMNS, 1);
    this.element = document.createElement('div');
    this.element.append(this.trace, this.fall);
  }

  setBand(startHz: number, stopHz: number) {
    this.band = { startHz, stopHz };
    this.columns.fill(-200);
    this.hasData = false;
    this.fallCtx.clearRect(0, 0, COLUMNS, FALL_HEIGHT);
    this.traceCtx.clearRect(0, 0, COLUMNS, TRACE_HEIGHT);
  }

  onSpectrum(startHz: number, binHz: number, db: Float32Array, floorDb: number, thresholdDb: number) {
    spectrumToColumns(this.columns, this.band, startHz, binHz, db);
    this.floorDb += (floorDb - this.floorDb) * 0.2;
    this.thresholdDb = thresholdDb;
    this.hasData = true;
  }

  /** Moves the strong line right away, ahead of the next measurement. */
  previewMargin(marginDb: number) {
    this.thresholdDb = this.floorDb + marginDb;
    if (this.hasData) this.drawTrace();
  }

  /** Called on a steady timer: adds a row and redraws the trace. */
  tick() {
    if (!this.hasData) return;
    this.drawRow();
    this.drawTrace();
  }

  private drawRow() {
    const ctx = this.fallCtx;
    ctx.drawImage(this.fall, 0, 1);
    const data = this.row.data;
    const low = this.floorDb - COLOR_FLOOR_OFFSET_DB;
    for (let c = 0; c < COLUMNS; c++) {
      const v = this.columns[c];
      const at = v <= -199 ? 0 : Math.max(0, Math.min(255, ((v - low) / COLOR_RANGE_DB) * 255)) | 0;
      data[c * 4] = PALETTE[at * 4];
      data[c * 4 + 1] = PALETTE[at * 4 + 1];
      data[c * 4 + 2] = PALETTE[at * 4 + 2];
      data[c * 4 + 3] = 255;
    }
    ctx.putImageData(this.row, 0, 0);
  }

  private drawTrace() {
    const ctx = this.traceCtx;
    const y = (db: number) => TRACE_HEIGHT * (1 - (db - (this.floorDb - TRACE_BELOW_DB)) / TRACE_RANGE_DB);
    ctx.clearRect(0, 0, COLUMNS, TRACE_HEIGHT);

    ctx.beginPath();
    ctx.moveTo(0, TRACE_HEIGHT);
    for (let c = 0; c < COLUMNS; c++) {
      const v = this.columns[c];
      ctx.lineTo(c, v <= -199 ? TRACE_HEIGHT : y(v));
    }
    ctx.lineTo(COLUMNS, TRACE_HEIGHT);
    ctx.closePath();
    ctx.fillStyle = 'rgba(88,166,255,.25)';
    ctx.fill();
    ctx.strokeStyle = '#58a6ff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // The strong line.
    const line = y(this.thresholdDb);
    ctx.strokeStyle = '#d29922';
    ctx.setLineDash([8, 5]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, line);
    ctx.lineTo(COLUMNS, line);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#d29922';
    ctx.font = '20px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('strong', COLUMNS - 6, Math.max(20, line - 6));
  }
}
