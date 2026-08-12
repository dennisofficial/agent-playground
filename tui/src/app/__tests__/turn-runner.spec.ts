import { describe, expect, it } from 'bun:test';
import { EMessageType } from '../../generated/prisma/enums.js';
import { EHarnessVariant, type EngineEvent } from '../../domain/message.js';
import { buildSystemPrompt } from '../../domain/system-prompt.js';
import { SESSION, THREAD, build } from './turn-runner.fixture.js';

describe('TurnRunnerService', () => {
  it('persists the user prompt before the engine runs', async () => {
    const { runner, messages } = build();
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'fix the drain', cwd: '/repo' });

    expect(messages.appended[0]).toMatchObject({
      payload: { type: EMessageType.user, text: 'fix the drain' },
    });
  });

  it('sends the human bare — a real user message reaches the model with no envelope', async () => {
    const { runner, engine } = build();
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'fix the drain', cwd: '/repo' });

    expect(engine.lastArgs?.prompt).toBe('fix the drain');
  });

  it('persists a harness injection as a harness message and envelopes it on the way out', async () => {
    const { runner, engine, messages } = build();
    await runner.run({
      thread: THREAD,
      session: SESSION,
      prompt: 'the previous leg stopped at the migration',
      harnessVariant: EHarnessVariant.handoff,
      cwd: '/repo',
    });

    expect(messages.appended[0]).toMatchObject({
      payload: {
        type: EMessageType.harness,
        variant: EHarnessVariant.handoff,
        text: 'the previous leg stopped at the migration',
      },
    });
    expect(engine.lastArgs?.prompt).toBe(
      '<harness variant="handoff">the previous leg stopped at the migration</harness>',
    );
  });

  it('declares the envelope vocabulary in the system prompt — otherwise the tags are noise', async () => {
    const { runner, engine } = build();
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

    expect(engine.lastArgs?.systemPrompt).toBe(buildSystemPrompt());
    expect(engine.lastArgs?.systemPrompt).toContain('<harness variant=');
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
    expect(sessions.recordEngineSessionId).toHaveBeenCalledWith({
      sessionId: 'session-1',
      engineSessionId: 'sdk-session-1',
    });
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
    expect(usage.track).toHaveBeenCalledWith({
      accountId: 'account-1',
      threadId: 'thread-1',
    });
    expect(usage.stopTracking).toHaveBeenCalledWith({
      accountId: 'account-1',
      threadId: 'thread-1',
    });
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
