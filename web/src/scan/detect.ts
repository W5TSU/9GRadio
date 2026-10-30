export interface DetectOptions {
  centerHz: number;
  binHz: number;
  thresholdDb: number;
  /** Above-line bins this close together are one signal. */
  mergeGapHz: number;
  /** Half-width of the region around the center ignored for the DC spike. */
  dcGuardHz: number;
  /** Fraction of the slice ignored at each end, where the filters roll off. */
  edgeFraction: number;
}

export interface DetectedSignal {
  peakHz: number;
  peakDb: number;
  /** Power-weighted middle of the signal. */
  centerHz: number;
  lowHz: number;
  highHz: number;
}

export function noiseFloorDb(db: Float32Array): number {
  const sorted = Float32Array.from(db).sort();
  return sorted[sorted.length >> 1];
}

export function detectSignals(db: Float32Array, o: DetectOptions): DetectedSignal[] {
  const n = db.length;
  const half = n >> 1;
  const first = Math.ceil(n * o.edgeFraction);
  const last = Math.floor(n * (1 - o.edgeFraction));
  const guardBins = Math.ceil(o.dcGuardHz / o.binHz);
  const mergeBins = Math.round(o.mergeGapHz / o.binHz);
  const found: DetectedSignal[] = [];

  let start = -1;
  let end = -1;
  let peak = -1;
  let sumP = 0;
  let sumPBin = 0;

  const flush = () => {
    if (start < 0) return;
    const at = (bin: number) => o.centerHz + (bin - half) * o.binHz;
    found.push({
      peakHz: at(peak),
      peakDb: db[peak],
      centerHz: Math.round(at(start) + (sumPBin / sumP) * o.binHz),
      lowHz: at(start),
      highHz: at(end),
    });
    start = -1;
  };

  for (let i = first; i < last; i++) {
    if (Math.abs(i - half) <= guardBins) continue;
    if (db[i] < o.thresholdDb) continue;
    if (start >= 0 && i - end > mergeBins) flush();
    if (start < 0) {
      start = i;
      peak = i;
      sumP = 0;
      sumPBin = 0;
    }
    end = i;
    if (db[i] > db[peak]) peak = i;
    const p = 10 ** (db[i] / 10);
    sumP += p;
    sumPBin += p * (i - start);
  }
  flush();
  return found;
}
