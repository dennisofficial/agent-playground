import { describe, expect, it, jest } from 'bun:test';
import { DRAIN_GRACE_MS, WAKE_UP_GRACE_MS } from '../background-hold.js';
import {
  fakeSdk,
  flush,
  isPending,
  settle,
  start,
  wakeUp,
} from './hold-harness.fixture.js';
import {
  assistantText,
  delegateText,
  delegateToolUse,
  rateLimit,
  result,
  taskNotification,
  taskProgress,
  taskStarted,
} from '../normalise/__tests__/scripted-turn.fixture.js';

/**
 * The turn does not end when the model stops talking — it ends when the work it spawned settles.
 *
 * A backgrounded delegate outlives the frame that launched it, and closing the stream at `result` takes
 * the CLI process and the delegate with it. That failure is written into Atlas's own tapes: a later
 * session opened to `task_notification status: "stopped"` and *"No completion record was found for
 * background agent … it may have been running when the previous Claude Code process exited"*.
 *
 * Driven through the real drain loop with a hand-fed SDK, because the bug was never in the rule — it
 * was in `break`. How a hold is ENDED is `claude-engine.abandon.spec.ts`.
 */

describe('a turn that spawned background work', () => {
  it('ends at `result` when it spawned nothing — the ordinary turn is unchanged', async () => {
    const { sdk, emit, finish } = fakeSdk();
    const turn = start(sdk);
    emit(result('done'));
    await settle();

    expect(await isPending(turn.done)).toBe(false);
    finish();
    expect((await turn.done).ok).toBe(true);
  });

  it('stays open past `result` while a subagent is still running, and ends when it settles', async () => {
    const { sdk, emit, finish } = fakeSdk();
    const turn = start(sdk);

    emit(taskStarted());
    emit(result('launched'));
    await settle();

    // The turn is NOT over. Ending here is what killed the delegate: the session closes, the CLI
    // process exits, and the notification is delivered to nobody.
    expect(await isPending(turn.done)).toBe(true);
    expect(turn.holds).toEqual([true]);

    // The delegate settles — which is the whole point of staying open, because this frame is what
    // wakes the model — and the model's next result closes the turn for real.
    emit(taskNotification());
    emit(result('read the report'));
    await settle();

    expect(await isPending(turn.done)).toBe(false);
    // The hold lifted the moment the session was in use again, before the turn ended.
    expect(turn.holds).toEqual([true, false]);
    finish();
  });

  it('reports the delegate through to its caller rather than swallowing it', async () => {
    const { sdk, emit, finish } = fakeSdk();
    const turn = start(sdk);
    emit(taskStarted());
    emit(result('launched'));
    await settle();
    emit(taskNotification());
    emit(result('done'));
    await settle();
    finish();
    await turn.done;

    expect(turn.events.map((event) => event.kind)).toContain('task_started');
    expect(turn.events.map((event) => event.kind)).toContain('task_settled');
  });

  /**
   * The CLI's orphan-recovery path: a previous process exited with work in flight, this session opens
   * to tombstones, they settle everything, and it answers with a `result` that entered no sampling
   * loop and produced nothing. The live set is empty by then, so the ordinary verdict is `end` — and
   * ending books a turn that never started.
   */
  it('holds a moment on a bare wake-up result, then ends when nothing follows', async () => {
    jest.useFakeTimers();
    try {
      const { sdk, emit } = fakeSdk();
      const turn = start(sdk);

      emit(wakeUp());
      await flush();
      expect(await isPending(turn.done)).toBe(true);

      // And it is a grace, not a hold: nothing is live, so nothing would ever re-evaluate this.
      jest.advanceTimersByTime(WAKE_UP_GRACE_MS + 1);
      await flush();
      expect(await isPending(turn.done)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('lets a continuation cancel the grace, rather than cutting it off five seconds in', async () => {
    jest.useFakeTimers();
    try {
      const { sdk, emit } = fakeSdk();
      const turn = start(sdk);

      emit(wakeUp());
      await flush();
      jest.advanceTimersByTime(WAKE_UP_GRACE_MS - 1);

      // The continuation starts streaming. The grace has done its job and must stop counting.
      emit(assistantText('picking up where the delegate left off'));
      await flush();
      jest.advanceTimersByTime(WAKE_UP_GRACE_MS * 4);
      await flush();
      expect(await isPending(turn.done)).toBe(true);

      // …and the turn ends on its own real result, as any turn does.
      emit(result('done'));
      await flush();
      expect(await isPending(turn.done)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * The grace has to end the turn by ENDING THE LOOP, not by closing the input under it.
   *
   * Closing the input from the timer leaves `state.live` true until the `finally` eventually runs, and
   * in that window `steer` accepts a message that `MessageQueue.push` then silently drops — the text
   * is lost and its queued chip never clears, because only the delivery callback removes it. Asserting
   * on `steer`'s answer is the cheapest way to pin the ordering, and it fails against the obvious
   * implementation.
   */
  it('refuses a steer once the grace has ended the turn, rather than swallowing it', async () => {
    jest.useFakeTimers();
    try {
      const { sdk, emit } = fakeSdk();
      const turn = start(sdk);

      emit(wakeUp());
      await flush();
      // Still live while the grace runs: the turn has not ended and a steer is genuinely deliverable.
      expect(turn.steer('actually, do this instead')).toBe(true);

      jest.advanceTimersByTime(WAKE_UP_GRACE_MS + 1);
      await flush();

      expect(await isPending(turn.done)).toBe(false);
      expect(turn.steer('and this')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('drops the grace the moment real work goes live — a deadline must not outlive its reason', async () => {
    jest.useFakeTimers();
    try {
      const { sdk, emit } = fakeSdk();
      const turn = start(sdk);

      emit(wakeUp());
      await flush();

      // A delegate starts and the model stops again. This is an ordinary uncapped hold now, and the
      // five-second deadline armed by the wake-up must not still be counting down under it.
      emit(taskStarted());
      emit(result('launched'));
      await flush();
      expect(turn.holds).toEqual([true]);

      jest.advanceTimersByTime(WAKE_UP_GRACE_MS * 10);
      await flush();
      expect(await isPending(turn.done)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('never treats a wake-up that actually worked as a bare one — that is the success path', async () => {
    const { sdk, emit } = fakeSdk();
    const turn = start(sdk);

    // A delegate settled, the model woke and did real work. `origin` is set, but so is
    // `terminal_reason`, and this is an ordinary turn end.
    emit(
      result('read the report', false, {
        terminal_reason: 'completed',
        num_turns: 16,
        origin: { kind: 'task-notification' },
      }),
    );
    await settle();

    expect(await isPending(turn.done)).toBe(false);
  });

  it('lets the stream ending close a held turn, so a crashed CLI cannot hang it forever', async () => {
    const { sdk, emit, finish } = fakeSdk();
    const turn = start(sdk);
    emit(taskStarted());
    emit(result('launched'));
    await settle();
    expect(await isPending(turn.done)).toBe(true);

    finish();
    await settle();
    expect(await isPending(turn.done)).toBe(false);
  });
});

/**
 * The verdict is only ever evaluated at a `result`, and an uncapped hold arms no timer. So a hold
 * whose work settles without waking the model has nothing left that will ever look at it again.
 *
 * Verified live that the ordinary path is fine — both settlements woke the model and produced results
 * — so this is a narrow tail. Its failure mode is total, which is why it has a floor.
 */
describe('a hold whose live set drains', () => {
  it('ends the turn when the settlement wakes nothing at all', async () => {
    jest.useFakeTimers();
    try {
      const { sdk, emit } = fakeSdk();
      const turn = start(sdk);
      emit(taskStarted());
      emit(result('launched'));
      await flush();
      expect(await isPending(turn.done)).toBe(true);

      // The delegate settles. No continuation follows — a `skip_transcript` notification, or a
      // settlement the model does not act on. Nothing is live and no result will ever arrive.
      emit(taskNotification());
      await flush();
      expect(await isPending(turn.done)).toBe(true);
      // The line still says held, because that is what the session is doing: waiting on a wake-up.
      expect(turn.holds).toEqual([true]);

      jest.advanceTimersByTime(DRAIN_GRACE_MS + 1);
      await flush();
      expect(await isPending(turn.done)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('lets the model waking cancel the backstop — it is a floor, not a deadline on the work', async () => {
    jest.useFakeTimers();
    try {
      const { sdk, emit } = fakeSdk();
      const turn = start(sdk);
      emit(taskStarted());
      emit(result('launched'));
      await flush();
      emit(taskNotification());
      await flush();
      jest.advanceTimersByTime(DRAIN_GRACE_MS - 1);

      // The auto-continuation starts streaming. The backstop has done its job and must stop counting.
      emit(assistantText('the delegate found two gaps'));
      await flush();
      jest.advanceTimersByTime(DRAIN_GRACE_MS * 4);
      await flush();
      expect(await isPending(turn.done)).toBe(true);
      expect(turn.holds).toEqual([true, false]);

      emit(result('done'));
      await flush();
      expect(await isPending(turn.done)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * The commonest hold there is: a live subagent, ticking progress at the SDK every few seconds. Those
   * ticks are the SDK's account of the very work being waited FOR — not the model coming back — and a
   * loop that reads them as a sign of life lifts the hold within seconds and never re-holds, because no
   * further `result` arrives to re-evaluate the verdict. The visible symptom is a shimmering working
   * line; the invisible one is that this backstop can never arm.
   */
  it('is not fooled out of the hold by the delegate reporting its own progress', async () => {
    jest.useFakeTimers();
    try {
      const { sdk, emit } = fakeSdk();
      const turn = start(sdk);
      emit(taskStarted());
      emit(result('launched'));
      await flush();
      expect(turn.holds).toEqual([true]);

      emit(taskProgress());
      emit(taskProgress({ uuid: 'u-task-progress-2' }));
      await flush();

      // Still held, and still held as far as anything downstream can tell: no lift, no re-hold.
      expect(turn.holds).toEqual([true]);
      expect(await isPending(turn.done)).toBe(true);

      // And the backstop still arms on the settlement, which is what the false lift would have cost.
      emit(taskNotification());
      await flush();
      jest.advanceTimersByTime(DRAIN_GRACE_MS + 1);
      await flush();
      expect(await isPending(turn.done)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * The same rule, against the frames that actually make up a held turn's traffic.
   *
   * A subagent's own tool calls and prose are forwarded onto the parent's stream as ordinary
   * `assistant`/`user` frames tagged with the spawning call. Reading those as the model coming back
   * lifted the hold one frame after it was entered — visible on this job's own live-verification tape,
   * where a delegate's `user` frame follows the held `result` immediately and the agent's settlement
   * then arrives with `holding` already false. The prose case is the sharp one: it normalises to a bare
   * `text` event with no parent id on it, so only the raw FRAME can say whose words they were.
   */
  it('is not fooled out of the hold by the delegate forwarding its own work', async () => {
    jest.useFakeTimers();
    try {
      const { sdk, emit, interrupts } = fakeSdk();
      const turn = start(sdk);
      emit(taskStarted());
      emit(result('launched'));
      await flush();
      expect(turn.holds).toEqual([true]);

      emit(delegateToolUse());
      emit(delegateText());
      await flush();

      // No lift, so esc still finds a held turn and still abandons rather than asking an idle model
      // to stop — the whole of Part 1, which the false lift silently undid.
      expect(turn.holds).toEqual([true]);
      expect(await isPending(turn.done)).toBe(true);

      // …and the backstop still arms when the delegate finally settles.
      emit(taskNotification());
      await flush();
      jest.advanceTimersByTime(DRAIN_GRACE_MS + 1);
      await flush();
      expect(await isPending(turn.done)).toBe(false);
      expect(interrupts()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  /** The quota meter rides in on whatever frame is passing. It is the API, not the model. */
  it('is not fooled out of the hold by a rate-limit reading', async () => {
    jest.useFakeTimers();
    try {
      const { sdk, emit } = fakeSdk();
      const turn = start(sdk);
      emit(taskStarted());
      emit(result('launched'));
      await flush();

      emit(rateLimit('five_hour', 0.62));
      await flush();
      expect(turn.holds).toEqual([true]);

      emit(taskNotification());
      await flush();
      jest.advanceTimersByTime(DRAIN_GRACE_MS + 1);
      await flush();
      expect(await isPending(turn.done)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * A turn that was never parked never reaches the backstop at all: every foreground subagent starts
   * and settles while the model is mid-sentence, and arming a 30-second floor under one would end
   * turns that are still being written.
   */
  it('arms nothing when work settles during ordinary generation, which is most turns', async () => {
    jest.useFakeTimers();
    try {
      const { sdk, emit } = fakeSdk();
      const turn = start(sdk);
      // A foreground subagent: started and settled inside the turn, with the model never stopping.
      emit(taskStarted());
      emit(taskNotification());
      await flush();

      jest.advanceTimersByTime(DRAIN_GRACE_MS * 4);
      await flush();
      // No hold was ever entered, so there is nothing to back-stop and the turn is still the model's.
      expect(turn.holds).toEqual([]);
      expect(await isPending(turn.done)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * The backstop is armed by a TRANSITION — a hold that had work and now has none — not merely by a
   * settlement reaching a parked loop. A wake-up grace is parked too, and a stray notification for
   * something this turn never started must not silently promote its five seconds into thirty. Without
   * the `heldWithWorkLive` guard the grace is re-armed at `DRAIN_GRACE_MS` and this turn outlives it.
   */
  it('does not let a stray settlement stretch a wake-up grace into the longer backstop', async () => {
    jest.useFakeTimers();
    try {
      const { sdk, emit } = fakeSdk();
      const turn = start(sdk);
      emit(wakeUp());
      await flush();

      // Parked on the grace, holding nothing — and a settlement arrives for work that was never this
      // turn's. Nothing transitioned, so nothing is re-armed.
      emit(taskNotification());
      await flush();
      expect(turn.holds).toEqual([]);

      jest.advanceTimersByTime(WAKE_UP_GRACE_MS + 1);
      await flush();
      expect(await isPending(turn.done)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});
