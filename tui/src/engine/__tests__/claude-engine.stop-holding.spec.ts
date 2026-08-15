import { describe, expect, it } from 'bun:test';
import { fakeSdk, isPending, settle, start } from './hold-harness.fixture.js';
import {
  result,
  taskStarted,
} from '../normalise/__tests__/scripted-turn.fixture.js';

/**
 * A hold never outlives the session it is held on.
 *
 * Two things decide a session is finished long before the model stops talking — a `rotate` tool call
 * and a context wall — and both arrive mid-stream, while there is no hold in existence to close. So
 * what they set is a sticky bar on the turn, read at the next `result`, and this is that read: given
 * the bar, the verdict is forced to `end` whatever is still live.
 *
 * Held here at the engine seam rather than end to end because this is where the claim actually is.
 * `app/` decides WHEN to bar a turn (`stop-holding.spec.ts`, `context-wall.spec.ts`, `rotate.spec.ts`);
 * the only thing that can prove the successor's first turn starts before the tasks settle is a turn
 * that ends with a task still live, which is what these assert.
 */
describe('a turn barred from holding', () => {
  it('ends at the result with a delegate still live, rather than waiting for it to settle', async () => {
    const { sdk, emit } = fakeSdk();
    // Already decided before the model even finished: the ordinary `rotate` shape, where the tool call
    // runs mid-generation and the result that follows it is the one this is read at.
    const turn = start(sdk, undefined, { mayHold: () => false });
    emit(taskStarted());
    emit(result('handed over'));
    await settle();

    expect(await isPending(turn.done)).toBe(false);
    // Nothing settled it — the task is still running and the turn ended anyway, which is the whole
    // point: rotation tears the CLI down regardless, so holding only delays the successor.
    expect(turn.events.some((event) => event.kind === 'task_settled')).toBe(false);
    // And it never entered the hold at all, so the working line never claimed it was waiting.
    expect(turn.holds).toEqual([]);
  });

  it('holds as usual when nothing has barred it — the control the test above needs', async () => {
    const { sdk, emit, finish } = fakeSdk();
    const turn = start(sdk, undefined, { mayHold: () => true });
    emit(taskStarted());
    emit(result('launched'));
    await settle();

    expect(await isPending(turn.done)).toBe(true);
    expect(turn.holds).toEqual([true]);
    finish();
  });

  it('is re-read at every result, so a bar raised mid-hold ends the turn at the next one', async () => {
    const { sdk, emit } = fakeSdk();
    let barred = false;
    const turn = start(sdk, undefined, { mayHold: () => !barred });
    emit(taskStarted());
    emit(result('launched'));
    await settle();
    expect(await isPending(turn.done)).toBe(true);
    expect(turn.holds).toEqual([true]);

    // The wall, or a `rotate` on the second breath of a held turn: the session is over now.
    barred = true;
    // A held turn produces several results — this is the wake-up the delegate's progress provoked,
    // and with the same work still live it would hold again.
    emit(result('still going'));
    await settle();

    expect(await isPending(turn.done)).toBe(false);
    expect(turn.events.some((event) => event.kind === 'task_settled')).toBe(false);
  });
});
