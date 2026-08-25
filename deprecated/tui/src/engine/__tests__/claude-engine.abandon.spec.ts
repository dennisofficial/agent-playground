import { describe, expect, it, jest } from 'bun:test';
import {
  SHELL_HOLD_CAP_MS,
  SHELL_HOLD_CAP_STEER,
} from '../background-hold.js';
import { fakeSdk, flush, isPending, settle, start } from './hold-harness.fixture.js';
import {
  assistantText,
  result,
  taskStarted,
} from '../normalise/__tests__/scripted-turn.fixture.js';

/**
 * The two ways a held turn is made to stop: the user's hand, and the policy's own clock.
 *
 * Split from `claude-engine.hold.spec.ts`, which asks whether a turn holds at all. This one takes the
 * hold as given and asks how it ENDS — the half of slice 02 that exists because a hold with no exit
 * but "quit Atlas" is worse than no hold.
 */


/**
 * Esc, in two stages, chosen by what the turn is actually doing.
 *
 * The stage is the ENGINE's to pick, not the UI's: the store's `holding` flag is a snapshot that can
 * be a frame out of date, and the whole failure this fixes is a press landing in the wrong branch.
 */
describe('esc on a turn that is holding', () => {
  it('sends the cooperative interrupt while the model is generating, and leaves the turn open', async () => {
    const { sdk, emit, finish, interrupts } = fakeSdk();
    const turn = start(sdk);
    emit(assistantText('working on it'));
    await settle();

    await turn.interrupt();
    await settle();

    expect(interrupts()).toBe(1);
    // An interrupt ASKS. The turn ends when the CLI answers, and until then the input is still open —
    // a press that closed it would take the steer-now path's text with it.
    expect(await isPending(turn.done)).toBe(true);
    expect(turn.steer('do this instead')).toBe(true);

    // Scripted as the SDK reports an aborted turn: `success`, not an error. Copying the tape's
    // `error_during_execution`/`is_error: true` gives a test that passes with the feature deleted.
    emit(result('stopped', false, { terminal_reason: 'aborted_tools' }));
    await settle();
    expect(await isPending(turn.done)).toBe(false);
    finish();
  });

  it('abandons instead, rather than asking a model that has already stopped to stop', async () => {
    const { sdk, emit, interrupts } = fakeSdk();
    const turn = start(sdk);
    emit(taskStarted());
    emit(result('launched'));
    await settle();
    expect(await isPending(turn.done)).toBe(true);

    await turn.interrupt();
    await settle();

    expect(await isPending(turn.done)).toBe(false);
    expect((await turn.done).interrupted).toBe(true);
    // And NOT through the control request. Sending one here is what made esc a no-op on a held turn:
    // the CLI answers it with a `result`, the verdict re-runs, the work is still live, it holds again.
    expect(interrupts()).toBe(0);
  });

  it('takes two presses when the first one leaves background work live', async () => {
    const { sdk, emit, interrupts } = fakeSdk();
    const turn = start(sdk);
    emit(taskStarted());
    emit(assistantText('launched it in the background'));
    await settle();

    // First press: the model is still talking, so this is the ordinary interrupt.
    await turn.interrupt();
    emit(result('stopped', false, { terminal_reason: 'aborted_tools' }));
    await settle();

    expect(interrupts()).toBe(1);
    // …and the turn is still held, because the delegate it spawned is still running. That is correct
    // — the interrupt stopped the model, not the work — and it is why there has to be a second stage.
    expect(await isPending(turn.done)).toBe(true);
    expect(turn.holds).toEqual([true]);

    // Second press, against a turn that is now visibly held: abandon.
    await turn.interrupt();
    await settle();

    expect(await isPending(turn.done)).toBe(false);
    expect(interrupts()).toBe(1);
  });

  /**
   * The abandon has to end the turn by ending the LOOP, for the same reason the grace does: closing
   * the input under it leaves `state.live` true until the `finally` runs, and in that window a steer
   * is accepted, silently dropped, and left queued in the UI forever.
   */
  it('refuses a steer once the abandon has ended the turn, rather than swallowing it', async () => {
    const { sdk, emit } = fakeSdk();
    const turn = start(sdk);
    emit(taskStarted());
    emit(result('launched'));
    await settle();
    expect(turn.steer('while it is still held')).toBe(true);

    await turn.interrupt();
    await settle();

    expect(await isPending(turn.done)).toBe(false);
    expect(turn.steer('and this')).toBe(false);
  });
});

/**
 * The cap is the one piece of policy that speaks to the model, and it is advisory: it steers and lets
 * the model's next natural result end the turn. It never kills a task and never closes stdin under one.
 */
describe('the shell cap, driven through the loop', () => {
  it('steers the model once, then lets its next result end the turn', async () => {
    jest.useFakeTimers();
    try {
      const { sdk, emit, steers } = fakeSdk();
      const turn = start(sdk, steers);
      // A backgrounded SHELL, not an agent: `local_bash` is what the cap exists for. An agent would
      // suspend it entirely.
      emit(taskStarted({ task_type: 'local_bash', subagent_type: undefined }));
      emit(result('kicked off the build'));
      await flush();
      expect(turn.holds).toEqual([true]);

      jest.advanceTimersByTime(SHELL_HOLD_CAP_MS + 1);
      await flush();

      // Told, not killed: the shell is still running and the turn is still open.
      expect(turn.steers).toEqual([SHELL_HOLD_CAP_STEER]);
      expect(await isPending(turn.done)).toBe(true);

      // The model answers, and THAT ends the turn — once capped, whatever is still live.
      emit(result('the build is still going; I will stop waiting on it'));
      await flush();
      expect(await isPending(turn.done)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('fires once per turn, not once per result', async () => {
    jest.useFakeTimers();
    try {
      const { sdk, emit, steers } = fakeSdk();
      const turn = start(sdk, steers);
      emit(taskStarted({ task_type: 'local_bash', subagent_type: undefined }));
      emit(result('kicked off the build'));
      // A second result with NOTHING between the two — the multi-result shape the hold made normal,
      // and deliberately no frame that would legitimately clear the cap. Arming again here leaves the
      // first timer running with nothing holding its handle: the model is told twice about one shell,
      // and the orphan outlives the turn.
      emit(result('still waiting on it'));
      await flush();

      jest.advanceTimersByTime(SHELL_HOLD_CAP_MS * 3);
      await flush();
      expect(turn.steers).toEqual([SHELL_HOLD_CAP_STEER]);
    } finally {
      jest.useRealTimers();
    }
  });
});
