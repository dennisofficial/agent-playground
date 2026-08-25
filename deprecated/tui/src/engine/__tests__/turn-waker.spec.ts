import { describe, expect, it, jest } from 'bun:test';
import { TurnWaker, WAIT_ENDED } from '../turn-waker.js';

/**
 * The channel by which a deadline or a keystroke ends a wait the drain loop is parked inside.
 *
 * Exercised through the engine as well, where it matters; here for the two properties that are
 * invisible from there because they only show up on the losing side of a race.
 */

/** Resolved, or still pending? */
async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('pending');
  return (await Promise.race([promise, Promise.resolve(marker)])) === marker;
}

describe('TurnWaker', () => {
  it('offers nothing to race against until something can end the wait', () => {
    expect(new TurnWaker().pending).toBeUndefined();
  });

  it('ends an open wait when fired, which is what esc does to a hold', async () => {
    const waker = new TurnWaker();
    waker.open();
    const wait = waker.pending;
    expect(await isPending(wait as Promise<unknown>)).toBe(true);

    waker.fire();
    expect(await wait).toBe(WAIT_ENDED);
  });

  it('ends an armed wait when its deadline passes, and re-arming restarts the clock', async () => {
    jest.useFakeTimers();
    try {
      const waker = new TurnWaker();
      waker.arm(1000);
      jest.advanceTimersByTime(999);
      // Re-armed on every further sign of life, so the window is "nothing since the last one" rather
      // than "since the first one" — a run of wake-ups must not be cut off mid-run.
      waker.arm(1000);
      jest.advanceTimersByTime(999);
      expect(await isPending(waker.pending as Promise<unknown>)).toBe(true);

      jest.advanceTimersByTime(2);
      expect(await waker.pending).toBe(WAIT_ENDED);
    } finally {
      jest.useRealTimers();
    }
  });

  it('forgets a deadline when a frame arrives, so it cannot fire under the turn that outran it', () => {
    jest.useFakeTimers();
    try {
      const waker = new TurnWaker();
      waker.arm(1000);
      waker.clear();
      jest.advanceTimersByTime(5000);
      expect(waker.pending).toBeUndefined();
      expect(waker.spent).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * A fire that lands while the loop holds a frame rather than a race is the one case a promise
   * cannot carry on its own. It is remembered instead: `spent` is what the loop checks before parking
   * again, and re-opening after one resolves at once rather than waiting for a second press.
   */
  it('remembers a fire that nothing was listening for', async () => {
    const waker = new TurnWaker();
    waker.fire();
    expect(waker.spent).toBe(true);

    waker.open();
    expect(await waker.pending).toBe(WAIT_ENDED);
  });

  it('does not let a later frame un-fire an abandon', () => {
    const waker = new TurnWaker();
    waker.fire();
    waker.clear();
    expect(waker.spent).toBe(true);
  });
});
