import type { RadioCommand } from '../app/coordinator';
import type { RadioSource } from '../radio/sources';
import type { RadioInfo } from '../radio/types';
import type { ScanConfig, ScanEvent } from '../scan/engine';

export type WorkerRequest =
  | RadioCommand
  | { type: 'connect'; source: RadioSource }
  | { type: 'start'; config: ScanConfig }
  | { type: 'stop' }
  | { type: 'timing'; marginDb: number; minStayMs: number; delayMs: number }
  | { type: 'gain'; db: number }
  | { type: 'ppm'; ppm: number }
  | { type: 'close' };

export type WorkerReply =
  | { type: 'connected'; info: RadioInfo }
  | { type: 'failed'; message: string }
  | { type: 'stopped' }
  | { type: 'event'; event: ScanEvent };
