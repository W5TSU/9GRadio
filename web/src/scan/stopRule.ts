export type StopState = 'hold' | 'play' | 'delay' | 'done';

/**
 * Decides how long a radio stays on a found signal.
 *
 * hold:  the minimum stay, n. Runs to the end regardless of the signal.
 * play:  past n, with the signal on.
 * delay: the signal dropped. A return goes back to play; a full quiet x is done.
 */
export class StopRule {
  private state: StopState = 'hold';
  private deadline: number;

  constructor(
    nMs: number,
    private readonly xMs: number,
    startMs: number,
  ) {
    this.deadline = startMs + nMs;
  }

  get current(): StopState {
    return this.state;
  }

  update(nowMs: number, signalOn: boolean): StopState {
    switch (this.state) {
      case 'hold':
        if (nowMs >= this.deadline) {
          if (signalOn) this.state = 'play';
          else this.startDelay(nowMs);
        }
        break;
      case 'play':
        if (!signalOn) this.startDelay(nowMs);
        break;
      case 'delay':
        if (signalOn) this.state = 'play';
        else if (nowMs >= this.deadline) this.state = 'done';
        break;
    }
    return this.state;
  }

  /** Time left in the hold or delay wait; 0 while the signal alone is keeping it. */
  remainingMs(nowMs: number): number {
    if (this.state === 'hold' || this.state === 'delay') {
      return Math.max(0, this.deadline - nowMs);
    }
    return 0;
  }

  private startDelay(nowMs: number) {
    this.state = 'delay';
    this.deadline = nowMs + this.xMs;
  }
}
