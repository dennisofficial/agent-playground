import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bgTaskCapRule } from '../../prompt-kit/jit';
import { BackgroundHoldTimer } from './background-hold-timer';

const HOLD_MS = 1_000;

function makeTimer(over: Partial<Parameters<typeof buildParams>[0]> = {}) {
  const onEvent = vi.fn();
  const cancelEnd = vi.fn();
  const steerPush = vi.fn();
  const params = buildParams({ onEvent, cancelEnd, steerPush, ...over });
  return { timer: new BackgroundHoldTimer(params), onEvent, cancelEnd, steerPush };
}

function buildParams(o: {
  onEvent: ReturnType<typeof vi.fn>;
  cancelEnd: ReturnType<typeof vi.fn>;
  steerPush: ReturnType<typeof vi.fn>;
  streaming?: boolean;
  isTurnEnded?: () => boolean;
}) {
  return {
    holdCapMs: HOLD_MS,
    streaming: o.streaming ?? true,
    isTurnEnded: o.isTurnEnded ?? (() => false),
    cancelEnd: o.cancelEnd,
    onEvent: o.onEvent as never,
    steer: { push: o.steerPush },
  };
}

describe('BackgroundHoldTimer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('tracks live bg tasks and reflects them on the getters', () => {
    const { timer } = makeTimer();
    expect(timer.hasLiveBgTasks).toBe(false);
    timer.trackTaskStarted('t1', false);
    expect(timer.hasLiveBgTasks).toBe(true);
    expect(timer.hasLiveSubagentTasks).toBe(false);
    timer.trackTaskStarted('t2', true);
    expect(timer.hasLiveSubagentTasks).toBe(true);
  });

  it('fires the advisory cap after holdCapMs: latches capping, emits capped, cancels the close', () => {
    const { timer, onEvent, cancelEnd, steerPush } = makeTimer();
    timer.trackTaskStarted('t1', false);
    timer.armHoldTimer();
    expect(timer.capping).toBe(false);

    vi.advanceTimersByTime(HOLD_MS);

    expect(timer.capping).toBe(true);
    expect(cancelEnd).toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'bg_task', status: 'capped' }),
    );
    if (bgTaskCapRule.enabled) expect(steerPush).toHaveBeenCalledTimes(1);
  });

  it('never caps while a subagent is live (uncapped)', () => {
    const { timer, onEvent } = makeTimer();
    timer.trackTaskStarted('sa', true);
    timer.armHoldTimer();
    vi.advanceTimersByTime(HOLD_MS * 3);
    expect(timer.capping).toBe(false);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('never caps on a non-streaming worker turn', () => {
    const { timer } = makeTimer({ streaming: false });
    timer.trackTaskStarted('t1', false);
    timer.armHoldTimer();
    vi.advanceTimersByTime(HOLD_MS);
    expect(timer.capping).toBe(false);
  });

  it('never caps once the turn has ended', () => {
    const { timer } = makeTimer({ isTurnEnded: () => true });
    timer.trackTaskStarted('t1', false);
    timer.armHoldTimer();
    vi.advanceTimersByTime(HOLD_MS);
    expect(timer.capping).toBe(false);
  });

  it('clearHold cancels a pending cap', () => {
    const { timer } = makeTimer();
    timer.trackTaskStarted('t1', false);
    timer.armHoldTimer();
    timer.clearHold();
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(timer.capping).toBe(false);
  });

  it('trackTaskSettled re-arms while a bare bg task remains, clears when none do', () => {
    const { timer } = makeTimer();
    timer.trackTaskStarted('t1', false);
    timer.trackTaskStarted('t2', false);

    // One settles — a bare bg task remains, so the hold re-arms and still caps.
    timer.trackTaskSettled('t1');
    expect(timer.hasLiveBgTasks).toBe(true);
    vi.advanceTimersByTime(HOLD_MS);
    expect(timer.capping).toBe(true);
  });

  it('trackTaskSettled clears the hold when the last task settles (no cap)', () => {
    const { timer } = makeTimer();
    timer.trackTaskStarted('t1', false);
    timer.armHoldTimer();
    timer.trackTaskSettled('t1');
    expect(timer.hasLiveBgTasks).toBe(false);
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(timer.capping).toBe(false);
  });
});
