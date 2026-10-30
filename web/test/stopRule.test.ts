import { describe, expect, it } from 'vitest';
import { StopRule } from '../src/scan/stopRule';

const n = 10_000;
const x = 3_000;

/** Runs the rule at 100 ms steps; `on` says when the signal is on the air. */
function run(on: (t: number) => boolean, untilMs: number) {
  const rule = new StopRule(n, x, 0);
  for (let t = 100; t <= untilMs; t += 100) {
    if (rule.update(t, on(t)) === 'done') return t;
  }
  return null;
}

describe('StopRule', () => {
  it('stays the full n, then a full x, after a one second blip', () => {
    expect(run((t) => t < 1000, 60_000)).toBe(13_000);
  });

  it('plays past n while the signal stays on, then waits x after it drops', () => {
    expect(run((t) => t < 25_000, 60_000)).toBe(28_000);
  });

  it('restarts the x delay when a reply arrives inside it', () => {
    // Signal until 12 s, reply 14-16 s, then quiet. x restarts at 16 s.
    const on = (t: number) => t < 12_000 || (t >= 14_000 && t < 16_000);
    expect(run(on, 60_000)).toBe(19_000);
  });

  it('leaves if the reply comes just after the x delay has run out', () => {
    // Quiet from 12 s, x expires at 15 s, reply at 15.5 s is too late.
    const on = (t: number) => t < 12_000 || t >= 15_500;
    expect(run(on, 60_000)).toBe(15_000);
  });

  it('never leaves on a stuck carrier', () => {
    expect(run(() => true, 600_000)).toBeNull();
  });

  it('does not start the x delay during n, even when the signal drops early', () => {
    const rule = new StopRule(n, x, 0);
    rule.update(1000, true);
    expect(rule.update(5000, false)).toBe('hold');
    expect(rule.update(9900, false)).toBe('hold');
    expect(rule.update(10_000, false)).toBe('delay');
    expect(rule.update(12_900, false)).toBe('delay');
    expect(rule.update(13_000, false)).toBe('done');
  });

  it('reports its state without moving it on', () => {
    const rule = new StopRule(n, x, 0);
    expect(rule.current).toBe('hold');
    rule.update(10_000, true);
    expect(rule.current).toBe('play');
  });

  it('reports how long is left in the current wait', () => {
    const rule = new StopRule(n, x, 0);
    rule.update(4000, true);
    expect(rule.remainingMs(4000)).toBe(6000);
    rule.update(10_000, false);
    expect(rule.remainingMs(11_000)).toBe(2000);
  });
});
