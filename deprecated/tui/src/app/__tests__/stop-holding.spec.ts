import { describe, expect, it } from 'bun:test';
import { SESSION, THREAD, build } from './turn-runner.fixture.js';

/**
 * `stopHolding` from the outside: a tool handler's one reach into a running turn.
 *
 * It has to be safe at every moment, because the caller cannot know which one it is in — `rotate`
 * runs mid-turn on a thread whose lane may or may not exist, whose query may or may not be open, and
 * whose loop may already have exited by the time the flag is read. So the interesting assertions here
 * are about lifetime, not about the hold: whether the bar reaches this turn, and whether it stops at
 * the end of it.
 *
 * The flag lives on the LANE rather than on the turn handle for exactly this reason. `FakeEngine`
 * fires its whole script synchronously inside `start()`, so a test built on it can manufacture an
 * ordering hazard that production does not have — and a bar that had to find `lane.turn` would be at
 * the mercy of it.
 */

/** Wait until the engine has been asked to start its nth turn. */
async function started(engine: { runs: number }, nth: number): Promise<void> {
  while (engine.runs < nth) await new Promise((resolve) => setImmediate(resolve));
}

describe('stopHolding', () => {
  /**
   * A call that finds no lane is silent AND leaves nothing behind — the next turn on that thread
   * still runs as an ordinary one.
   *
   * `peek` rather than `for` is the implementation of the second half, and it is worth saying that
   * this test does not pin it: a minted idle lane is invisible from outside `TurnLanes`, and
   * `execute()` would reset its flag anyway. What is pinned is the observable claim.
   */
  it('is silent when the thread has no lane, and bars nothing that comes after', async () => {
    const { runner, engine } = build();

    expect(() => runner.stopHolding(THREAD.id)).not.toThrow();
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

    expect(engine.lastArgs?.mayHold?.()).toBe(true);
  });

  it('bars the running turn, however many times it is called, and outlives the loop', async () => {
    const { runner, engine } = build();
    let release = (): void => undefined;
    engine.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const turn = runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });
    await started(engine, 1);

    expect(engine.lastArgs?.mayHold?.()).toBe(true);
    runner.stopHolding(THREAD.id);
    runner.stopHolding(THREAD.id);
    expect(engine.lastArgs?.mayHold?.()).toBe(false);

    release();
    await turn;
    // After the loop has exited it is just a question with an answer, and the lane it was asked of
    // has been reaped. Nothing here may throw: the caller has no way to know it arrived late.
    expect(() => runner.stopHolding(THREAD.id)).not.toThrow();
    expect(engine.lastArgs?.mayHold?.()).toBe(false);
  });

  it('is per TURN, not per lane forever — the next turn on the thread may hold again', async () => {
    const { runner, engine } = build();
    let release = (): void => undefined;
    engine.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });
    await started(engine, 1);
    runner.stopHolding(THREAD.id);

    // Queued while the first turn is still in flight, so the LANE survives into it — which is the
    // only shape that can tell "reset per turn" apart from "the lane was reaped and rebuilt".
    const second = runner.run({ thread: THREAD, session: SESSION, prompt: 'again', cwd: '/repo' });
    release();
    await Promise.all([first, second]);
    await started(engine, 2);

    expect(engine.runs).toBe(2);
    expect(engine.lastArgs?.mayHold?.()).toBe(true);
  });
});
