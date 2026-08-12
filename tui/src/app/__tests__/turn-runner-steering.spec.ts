import { describe, expect, it, mock, spyOn } from 'bun:test';
import { EMessageType } from '../../generated/prisma/enums.js';
import type { EngineEvent } from '../../domain/message.js';
import { ConversationStoreRegistry } from '../conversation-store.registry.js';
import { OTHER_THREAD, SESSION, THREAD, build } from './turn-runner.fixture.js';

describe('steering', () => {
  const ARGS = { thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' };

  it('queues immediately but only commits when the engine actually pulls it', async () => {
    const { runner, engine, store, messages } = build();
    let release = (): void => undefined;
    engine.hold = new Promise<void>((resolve) => (release = resolve));

    const turn = runner.run(ARGS);
    await new Promise((resolve) => setImmediate(resolve));

    runner.steer({ thread: THREAD, session: SESSION, text: 'also check the tool-result path' });

    expect(store.getSnapshot().queued).toHaveLength(1);
    expect(messages.appended.map((m) => m.payload.type)).toEqual([EMessageType.user]);

    engine.steerCallback?.();

    expect(store.getSnapshot().queued).toHaveLength(0);
    release();
    await turn;
    expect(messages.appended[1]?.payload).toMatchObject({
      type: EMessageType.user,
      text: 'also check the tool-result path',
    });
  });

  it('drops the queued item when there is no turn to take it — no ghost entries', () => {
    const { runner, store } = build();

    runner.steer({ thread: THREAD, session: SESSION, text: 'too late' });
    expect(store.getSnapshot().queued).toHaveLength(0);
  });

  it('marks interrupting so the working line can say so', async () => {
    const { runner, store, engine } = build();
    let release = (): void => undefined;
    engine.hold = new Promise<void>((resolve) => (release = resolve));

    const turn = runner.run(ARGS);
    await new Promise((resolve) => setImmediate(resolve));

    await runner.interrupt(THREAD.id);
    expect(store.getSnapshot().interrupting).toBe(true);
    expect(engine.interrupted).toBe(true);

    release();
    await turn;
  });

  it('interrupts only the thread it was asked about', async () => {
    const { runner, stores, engine } = build();
    let release = (): void => undefined;
    engine.hold = new Promise<void>((resolve) => (release = resolve));

    const both = Promise.all([
      runner.run(ARGS),
      runner.run({ ...ARGS, thread: OTHER_THREAD }),
    ]);
    await new Promise((resolve) => setImmediate(resolve));

    await runner.interrupt(OTHER_THREAD.id);

    expect(stores.for(THREAD.id).getSnapshot().interrupting).toBe(false);
    expect(stores.for(OTHER_THREAD.id).getSnapshot().interrupting).toBe(true);

    release();
    await both;
  });
});

describe('turn integrity', () => {
  const ARGS = { thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' };

  it('never runs two appends at once — the thread ordinal is UNIQUE', async () => {
    const { runner, messages } = build([
      { kind: 'text', text: 'Let me look.' },
      { kind: 'tool_call', toolUseId: 't1', name: 'Read', input: {} },
      { kind: 'tool_result', toolUseId: 't1', ok: true, summary: 'Read 3 lines', detail: [] },
    ]);
    messages.slow = true;

    await runner.run(ARGS);

    expect(messages.maxInFlight).toBe(1);
    expect(messages.appended.map((m) => m.payload.type)).toEqual([
      EMessageType.user,
      EMessageType.assistant,
      EMessageType.tool_call,
      EMessageType.tool_result,
    ]);
  });

  it('keeps a failed persist from taking the process down', async () => {
    const { runner, messages, store } = build([{ kind: 'text', text: 'hello' }]);
    const append = messages.append.bind(messages);
    spyOn(messages, 'append').mockImplementation(async (args) => {
      if (args.payload.type === EMessageType.assistant) throw new Error('UNIQUE constraint failed');
      return append(args);
    });

    await expect(runner.run(ARGS)).resolves.toBeUndefined();
    expect(store.getSnapshot().notices.join()).toMatch(/could not record/);
  });

  it('ends the turn when credential setup throws — no immortal spinner', async () => {
    const { runner, store, vault } = build();
    vault.freshCredential.mockRejectedValueOnce(new Error('account expired'));

    await expect(runner.run(ARGS)).rejects.toThrow('account expired');

    expect(store.getSnapshot().running).toBe(false);
    expect(runner.busy(THREAD.id)).toBe(false);
  });

  it('is busy from the first tick, before the engine query opens', async () => {
    const { runner } = build();
    const turn = runner.run(ARGS);
    expect(runner.busy(THREAD.id)).toBe(true);
    await turn;
    expect(runner.busy(THREAD.id)).toBe(false);
  });

  it('queues a second turn on the SAME thread behind the first', async () => {
    const { runner, engine } = build();

    await Promise.all([runner.run(ARGS), runner.run({ ...ARGS, prompt: 'again' })]);

    expect(engine.runs).toBe(2);
    expect(engine.maxConcurrent).toBe(1);
  });

  it('runs turns in DIFFERENT threads at the same time', async () => {
    const { runner, engine } = build();
    let release = (): void => undefined;
    engine.hold = new Promise<void>((resolve) => (release = resolve));

    const both = Promise.all([
      runner.run(ARGS),
      runner.run({ ...ARGS, thread: OTHER_THREAD, prompt: 'elsewhere' }),
    ]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(engine.maxConcurrent).toBe(2);
    expect(runner.busy(THREAD.id)).toBe(true);
    expect(runner.busy(OTHER_THREAD.id)).toBe(true);

    release();
    await both;
    expect(runner.busy(THREAD.id)).toBe(false);
    expect(runner.busy(OTHER_THREAD.id)).toBe(false);
  });

  it('keeps each thread\u2019s transcript to itself', async () => {
    const { runner, stores } = build([{ kind: 'text', text: 'from thread one' }]);

    await runner.run(ARGS);

    expect(stores.for(THREAD.id).getSnapshot().messages).not.toHaveLength(0);
    expect(stores.for(OTHER_THREAD.id).getSnapshot().messages).toHaveLength(0);
  });

  it('holds a steer typed during credential setup rather than dropping it', async () => {
    const { runner, engine, store, vault } = build();
    let releaseCredential = (): void => undefined;
    vault.freshCredential.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCredential = () => resolve({ claudeAiOauth: {} });
        }) as never,
    );
    let releaseTurn = (): void => undefined;
    engine.hold = new Promise<void>((resolve) => (releaseTurn = resolve));

    const turn = runner.run(ARGS);
    await new Promise((resolve) => setImmediate(resolve));

    expect(runner.steer({ thread: THREAD, session: SESSION, text: 'also check the logs' })).toBe(true);
    expect(store.getSnapshot().queued).toHaveLength(1);

    releaseCredential();
    await new Promise((resolve) => setImmediate(resolve));

    expect(engine.steerTexts).toContain('also check the logs');

    releaseTurn();
    await turn;
  });
});

describe('account rotation at a turn boundary', () => {
  it('notes the swap inline and runs the turn on the new account', async () => {
    const { runner, rotator, store, engine, messages } = build();
    rotator.considerRotation.mockResolvedValue({
      kind: 'rotated',
      from: { id: 'a1', label: 'dennis@personal' },
      to: { id: 'a2', label: 'work@company' },
    } as never);

    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

    expect(store.getSnapshot().notices).toEqual([
      'switched to work@company · dennis@personal hit its 5-hour limit',
    ]);
    expect(engine.lastArgs?.model).toBe('claude-opus-5');
    // The swap note is LIVE-ONLY and stays that way. It is Atlas talking to the human about its own
    // bookkeeping — it persists to nothing and never reaches the model, which is the opposite of a
    // harness `notice`. Collapsing the two would silently start billing the agent for rotation
    // chatter and put a note in the transcript that outlives the reason for it.
    expect(messages.appended.map((m) => m.payload.type)).toEqual([EMessageType.user]);
  });
});
