import { describe, expect, it, mock, spyOn } from 'bun:test';
import type { EngineEvent, Message, MessagePayload } from '../../domain/message.js';
import { EMessageType } from '../../generated/prisma/enums.js';
import type { EngineSession, Thread } from '../../generated/prisma/client.js';
import type { RunArgs, RunResult, RunningTurn } from '../../engine/claude-engine.service.js';
import { ConversationStoreRegistry } from '../conversation-store.registry.js';
import { TurnRunnerService } from '../turn-runner.service.js';

const THREAD = { id: 'thread-1', role: 'builder' } as unknown as Thread;
const OTHER_THREAD = { id: 'thread-2', role: 'builder' } as unknown as Thread;
const SESSION = {
  id: 'session-1',
  accountId: 'account-1',
  engine: 'claude',
  model: 'claude-opus-5',
  engineSessionId: null,
  ordinal: 1,
} as unknown as EngineSession;

class FakeEngine {
  lastArgs?: RunArgs;
  steerCallback?: () => void;
  interrupted = false;
  script: EngineEvent[] = [];
  readonly steerTexts: string[] = [];
  runs = 0;
  private concurrent = 0;
  maxConcurrent = 0;
  hold?: Promise<void>;

  start(args: RunArgs): RunningTurn {
    this.lastArgs = args;
    this.runs += 1;
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);

    const engine = this;
    let live = true;
    const done = (async (): Promise<RunResult> => {
      for (const event of engine.script) args.onEvent(event);
      await (engine.hold ?? Promise.resolve());
      live = false;
      engine.concurrent -= 1;
      return { ok: true, engineSessionId: 'sdk-session-1', interrupted: engine.interrupted };
    })();

    return {
      steer(text: string, onConsumed?: () => void): boolean {
        if (!live) return false;
        engine.steerTexts.push(text);
        engine.steerCallback = onConsumed;
        return true;
      },
      async interrupt(): Promise<void> {
        engine.interrupted = true;
      },
      get pendingSteers(): number {
        return 0;
      },
      done,
    };
  }
}

class FakeMessageRepository {
  readonly appended: { payload: MessagePayload; sessionId: string }[] = [];
  slow = false;
  inFlight = 0;
  maxInFlight = 0;
  private ordinal = 0;

  async append(args: { threadId: string; sessionId: string; payload: MessagePayload }): Promise<Message> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    if (this.slow) await new Promise((resolve) => setImmediate(resolve));
    this.appended.push({ payload: args.payload, sessionId: args.sessionId });
    this.inFlight -= 1;
    return {
      id: `m-${this.ordinal}`,
      threadId: args.threadId,
      sessionId: args.sessionId,
      ordinal: this.ordinal++,
      payload: args.payload,
      createdAt: new Date(0),
    };
  }
}

function build(script: EngineEvent[] = []) {
  const engine = new FakeEngine();
  engine.script = script;
  const messages = new FakeMessageRepository();
  const stores = new ConversationStoreRegistry();
  const store = stores.for(THREAD.id);

  const accounts = {
    recordUsage: mock(async () => undefined),
    findById: mock(async () => null),
  };
  const sessions = {
    recordEngineSessionId: mock(async () => undefined),
    recordContextPercent: mock(async () => undefined),
  };
  const vault = { freshCredential: mock(async () => ({ claudeAiOauth: {} })) };
  const env = { CLAUDE_CONFIG_DIR: '/tmp/claude', CLAUDE_CODE_OAUTH_TOKEN: 'tok' };
  const homes = {
    prepareClaudeHome: mock(() => env),
    claim: mock(async (_blob: unknown, start: (e: typeof env) => unknown) => start(env)),
  };
  const rotator = { considerRotation: mock(async () => ({ kind: 'kept' as const })) };
  const turns = {
    record: mock(async (_args: Record<string, unknown>) => undefined),
    lastForThread: mock(async () => null),
  };
  const usage = { track: mock(), stopTracking: mock(), kick: mock() };


  const runner = new TurnRunnerService(
    engine as never,
    vault as never,
    homes as never,
    rotator as never,
    usage as never,
    accounts as never,
    messages as never,
    sessions as never,
    turns as never,
    stores,
  );

  return {
    runner,
    engine,
    messages,
    store,
    stores,
    accounts,
    sessions,
    turns,
    rotator,
    homes,
    vault,
    usage,
  };
}

describe('TurnRunnerService', () => {
  it('persists the user prompt before the engine runs', async () => {
    const { runner, messages } = build();
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'fix the drain', cwd: '/repo' });

    expect(messages.appended[0]).toMatchObject({
      payload: { type: EMessageType.user, text: 'fix the drain' },
    });
  });

  it('injects the credential into the engine env every turn — auth is a per-turn concern', async () => {
    const { runner, engine, homes } = build();
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

    expect(homes.claim).toHaveBeenCalledTimes(1);
    expect(engine.lastArgs?.env).toEqual({
      CLAUDE_CONFIG_DIR: '/tmp/claude',
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
    });
  });

  it('persists authoritative blocks and NOT deltas', async () => {
    const { runner, messages } = build([
      { kind: 'text_delta', text: 'Let me ' },
      { kind: 'text_delta', text: 'look.' },
      { kind: 'text', text: 'Let me look.' },
      { kind: 'tool_call', toolUseId: 't1', name: 'Read', input: {} },
      { kind: 'tool_result', toolUseId: 't1', ok: true, summary: 'Read 3 lines', detail: [] },
    ]);
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

    expect(messages.appended.map((m) => m.payload.type)).toEqual([
      EMessageType.user,
      EMessageType.assistant,
      EMessageType.tool_call,
      EMessageType.tool_result,
    ]);
  });

  it('feeds deltas to the live tail only', async () => {
    const { runner, store } = build([
      { kind: 'text_delta', text: 'abc' },
      { kind: 'text_delta', text: 'def' },
    ]);
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });
    expect(store.getSnapshot().messages.map((m) => m.payload.type)).toEqual([EMessageType.user]);
  });

  it('records the SDK session id so the next turn can resume', async () => {
    const { runner, sessions } = build();
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });
    expect(sessions.recordEngineSessionId).toHaveBeenCalledWith('session-1', 'sdk-session-1');
  });

  it('turns a usage event into a context percentage', async () => {
    const { runner, store } = build([
      { kind: 'usage', contextTokens: 120_000, contextLimit: 1_000_000 },
    ]);
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });
    expect(store.getSnapshot().contextPercent).toBe(12);
  });

  it("never lets a subagent's window move the ctx meter", async () => {
    const { runner, store, sessions } = build([
      { kind: 'usage', contextTokens: 120_000, contextLimit: 200_000 },
      { kind: 'usage', contextTokens: 11_511, contextLimit: 200_000, parentToolUseId: 'task-1' },
    ]);
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

    expect(store.getSnapshot().contextPercent).toBe(60);
    expect(sessions.recordContextPercent).toHaveBeenCalledWith('session-1', 60);
  });

  it('stores the last context reading so reopening the thread is not blank', async () => {
    const { runner, sessions } = build([
      { kind: 'usage', contextTokens: 40_000, contextLimit: 200_000 },
      { kind: 'usage', contextTokens: 60_000, contextLimit: 200_000 },
    ]);
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });
    expect(sessions.recordContextPercent).toHaveBeenCalledTimes(1);
    expect(sessions.recordContextPercent).toHaveBeenCalledWith('session-1', 30);
  });

  it('polls usage for the duration of the turn, then once more after it', async () => {
    const { runner, usage } = build();
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });
    expect(usage.track).toHaveBeenCalledWith('account-1', 'thread-1');
    expect(usage.stopTracking).toHaveBeenCalledWith('account-1', 'thread-1');
  });

  it('harvests rate-limit frames onto both the meter and the account row', async () => {
    const { runner, store, accounts } = build([
      { kind: 'rate_limit', window: 'fiveHour', utilization: 34, resetsAt: '2026-08-02T22:00:00Z' },
    ]);
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

    expect(store.getSnapshot().fiveHour).toEqual({
      utilization: 34,
      resetsAt: '2026-08-02T22:00:00Z',
    });
    expect(accounts.recordUsage).toHaveBeenCalledWith('account-1', {
      window: 'fiveHour',
      utilization: 34,
      resetsAt: '2026-08-02T22:00:00Z',
    });
  });

  it('clears the running state when the turn ends', async () => {
    const { runner, store } = build();
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });
    expect(store.getSnapshot().running).toBe(false);
    expect(store.getSnapshot().tail).toBeNull();
  });

  it("writes the turn's real cost to the ledger, not the live estimate", async () => {
    const { runner, store, turns } = build([
      { kind: 'text_delta', text: 'hello there' },
      {
        kind: 'result',
        ok: true,
        usage: {
          inputTokens: 12,
          outputTokens: 4_200,
          cacheReadTokens: 90_000,
          cacheWriteTokens: 1_100,
          costUsd: 0.42,
          model: 'claude-opus-5',
        },
      },
    ]);
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

    const row = turns.record.mock.calls[0]?.[0] ?? {};
    expect(row.threadId).toBe('thread-1');
    expect(row.sessionId).toBe('session-1');
    expect(row.ok).toBe(true);
    expect(row.usage).toMatchObject({ outputTokens: 4_200, cacheReadTokens: 90_000, costUsd: 0.42 });

    expect(store.getSnapshot().lastTurn?.outputTokens).toBe(4_200);
  });

  it('records a turn the engine never reported usage for, rather than skipping it', async () => {
    const { runner, store, turns } = build([{ kind: 'text_delta', text: 'partial' }]);
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

    const row = turns.record.mock.calls[0]?.[0] ?? {};
    expect(row.usage).toBeUndefined();
    expect(typeof row.durationMs).toBe('number');
    expect(store.getSnapshot().lastTurn?.outputTokens).toBeGreaterThan(0);
  });
});

describe('steering', () => {
  const ARGS = { thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' };

  it('queues immediately but only commits when the engine actually pulls it', async () => {
    const { runner, engine, store, messages } = build();
    let release = (): void => undefined;
    engine.hold = new Promise<void>((resolve) => (release = resolve));

    const turn = runner.run(ARGS);
    await new Promise((resolve) => setImmediate(resolve));

    runner.steer(THREAD, SESSION, 'also check the tool-result path');

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

    runner.steer(THREAD, SESSION, 'too late');
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

    expect(runner.steer(THREAD, SESSION, 'also check the logs')).toBe(true);
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
    const { runner, rotator, store, engine } = build();
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
  });
});
