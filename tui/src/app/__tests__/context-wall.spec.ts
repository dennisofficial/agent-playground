import { describe, expect, it } from 'bun:test';
import { EHarnessVariant, type EngineEvent } from '../../domain/message.js';
import { ESessionEndReason } from '../../generated/prisma/enums.js';
import type { EngineSession } from '../../generated/prisma/client.js';
import { NEXT_SESSION, SESSION, THREAD, build } from './turn-runner.fixture.js';

/**
 * The two failures this ticket separates, at the only place that can tell them apart.
 *
 * A crashed subprocess and a transcript that no longer fits both arrive as an error event, and
 * treating them alike is expensive in one direction: rotating on a crash throws away a healthy
 * context for free, while retrying at the wall re-sends the same oversized request forever.
 */

/** A leg that has actually run — the wall only forces a rotation when there is a transcript. */
const RUNNING: EngineSession = { ...SESSION, engineSessionId: 'sdk-session-1' } as EngineSession;

const WALL: EngineEvent = {
  kind: 'error',
  title: 'API Error: 400',
  detail: 'prompt is too long: 213043 tokens > 200000 maximum',
};

const CRASH: EngineEvent = {
  kind: 'error',
  title: 'Engine error: claude agent sdk exited',
  detail: 'spawn ENOENT · Thread preserved · r to restart',
  retryable: true,
};

describe('an engine error', () => {
  it('does NOT rotate — the transcript is intact and restarting in place costs nothing', async () => {
    const { runner, sessionManager } = build([CRASH]);

    await runner.run({ thread: THREAD, session: RUNNING, prompt: 'go', cwd: '/repo' });

    expect(sessionManager.rotateSession).not.toHaveBeenCalled();
  });
});

describe('the context wall', () => {
  it('ends the session with `context_wall` — the one forced rotation', async () => {
    const { runner, sessionManager } = build([WALL]);

    await runner.run({ thread: THREAD, session: RUNNING, prompt: 'go', cwd: '/repo' });

    expect(sessionManager.rotateSession).toHaveBeenCalledTimes(1);
    const [, current, endReason] = sessionManager.rotateSession.mock.calls[0] ?? [];
    expect(current).toMatchObject({ id: RUNNING.id });
    expect(endReason).toBe(ESessionEndReason.context_wall);
  });

  it('opens the successor on a stub that sends it to the transcript, not to a host summary', async () => {
    const { runner, sessionManager, messages } = build([WALL]);

    await runner.run({
      thread: THREAD,
      session: RUNNING,
      prompt: 'go',
      cwd: '/repo',
      brief: 'build instructions',
    });

    const [, , , handoff] = sessionManager.rotateSession.mock.calls[0] ?? [];
    expect(handoff).toContain(`atlas transcript ${THREAD.id} --full`);

    // The successor's turn is QUEUED, not awaited — the failed turn must not wait on it — so the
    // assertion has to wait for the lane to drain, exactly as the UI does.
    while (runner.busy(THREAD.id)) await new Promise((resolve) => setImmediate(resolve));

    // Delivered as a harness message on the NEW session, and it fires a turn there: a stub stored
    // and never spoken would leave the fresh leg to answer the next human message from nothing.
    const seeded = messages.appended.find(
      (entry) => entry.sessionId === NEXT_SESSION.id,
    );
    expect(seeded?.payload).toMatchObject({
      variant: EHarnessVariant.handoff,
    });
  });

  /**
   * A walled session must not be held open on background work, and the reason is sharper than the
   * wasted wait: while a turn is held the lane stays busy, so every `send()` takes the steer branch —
   * into a session that is refusing every request. The hold widens that from the tail of a turn to
   * however long the tasks run, which is text vanishing into a dead session.
   *
   * The session with no engine id is used deliberately: no rotation follows it, so `lastArgs` is
   * still THIS turn's rather than the successor's.
   */
  it('bars the turn from holding, so background work cannot keep a dead session open', async () => {
    const { runner, engine, turns } = build([WALL]);

    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

    expect(engine.lastArgs?.mayHold?.()).toBe(false);
    // And still exactly ONE ledger row. A held turn produces several results, so "the turn ended"
    // has to stay a single event: `Turn` has no unique constraint, `takeUsage` is a destructive read
    // and `rotateOnContextWall` is not idempotent, so a second pass corrupts all three in silence.
    expect(turns.record).toHaveBeenCalledTimes(1);
  });

  it('leaves an ordinary engine error free to hold — it is the WALL that bars, not any failure', async () => {
    const { runner, engine } = build([CRASH]);

    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

    expect(engine.lastArgs?.mayHold?.()).toBe(true);
  });

  it('does not rotate a leg that never ran — that request was too big on its own, and would be again', async () => {
    const { runner, sessionManager } = build([WALL]);

    // No `engineSessionId`: nothing was ever exchanged, so there is no transcript to abandon and a
    // rotation would open a fresh session only to fail identically. This is the loop guard.
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

    expect(sessionManager.rotateSession).not.toHaveBeenCalled();
  });
});

describe('a session that rotated under the caller', () => {
  it('runs the turn on the live session rather than the retired copy it was handed', async () => {
    const { runner, engine, sessions } = build();
    // What `rotate` leaves behind: the UI still holds leg 1, the thread is on leg 2 — which has
    // run at least once, so it has an engine session of its own to resume.
    sessions.currentForThread.mockImplementation(async () => ({
      ...NEXT_SESSION,
      engineSessionId: 'sdk-session-2',
    }) as EngineSession);

    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

    // Resuming leg 1's engine session would re-open exactly the context the rotation left behind.
    expect(engine.lastArgs?.resume).toBe('sdk-session-2');
  });
});
