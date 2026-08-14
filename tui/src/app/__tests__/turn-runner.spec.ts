import { describe, expect, it } from 'bun:test';
import { EMessageType } from '../../generated/prisma/enums.js';
import { EContextSignal } from '../../domain/context-nudge.js';
import { EHarnessVariant, type EngineEvent } from '../../domain/message.js';
import { buildSystemPrompt } from '../../domain/system-prompt.js';
import { ACCOUNT_ID, SESSION, THREAD, build } from './turn-runner.fixture.js';

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

  it('draws a usage event against the WINDOW the engine reported', async () => {
    // The gauge answers "how full is the context": 120K of a million-token window is 12%. The
    // budget still runs the nudges, in tokens, and can fire while this reads calm.
    const { runner, store } = build([
      { kind: 'usage', contextTokens: 120_000, contextLimit: 1_000_000 },
    ]);
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });
    expect(store.getSnapshot().contextReading).toEqual({
      tokens: 120_000,
      percent: 12,
      // Two thirds of the way to the 180K budget — the last band before the heads-up.
      band: 'normal',
      signal: EContextSignal.budget,
    });
  });

  it("never lets a subagent's window move the ctx meter", async () => {
    const { runner, store, sessions } = build([
      { kind: 'usage', contextTokens: 120_000, contextLimit: 200_000 },
      { kind: 'usage', contextTokens: 11_511, contextLimit: 200_000, parentToolUseId: 'task-1' },
    ]);
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

    // 60% — the main thread's 120K of 200K. The subagent's 11.5K frame would have redrawn it at 6%.
    expect(store.getSnapshot().contextReading?.percent).toBe(60);
    expect(sessions.recordContextUsage).toHaveBeenCalledWith('session-1', {
      contextTokens: 120_000,
      contextLimit: 200_000,
    });
  });

  it("keeps a delegate's calls out of the transcript, and counts them on its row instead", async () => {
    const { runner, store, messages } = build([
      { kind: 'tool_call', toolUseId: 'toolu_parent', name: 'Agent', input: {} },
      {
        kind: 'task_started',
        taskId: 'task-1',
        parentToolUseId: 'toolu_parent',
        description: 'Find transcript rendering',
        agentType: 'Explore',
        taskType: 'local_agent',
        background: false,
      },
      {
        kind: 'tool_call',
        toolUseId: 'toolu_sub',
        name: 'Grep',
        input: { pattern: 'markdown' },
        parentToolUseId: 'toolu_parent',
      },
      {
        kind: 'tool_result',
        toolUseId: 'toolu_sub',
        ok: true,
        summary: '6 matches',
        detail: [],
        parentToolUseId: 'toolu_parent',
      },
    ]);
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

    // The prompt and the Agent call this thread really made — and nothing the delegate did. A real
    // tape carries 31 subagent tool calls in one turn, every one of which used to be written here.
    expect(messages.appended.map((m) => m.payload.type)).toEqual([
      EMessageType.user,
      EMessageType.tool_call,
    ]);
    const delegate = store.getSnapshot().delegates[0];
    expect(delegate).toMatchObject({
      toolUseId: 'toolu_parent',
      agentType: 'Explore',
      toolUses: 1,
      lastTool: 'Grep',
    });
  });

  it("does not leave a delegate's spinner running over the thread's own tool row", async () => {
    const { runner, store } = build([
      {
        kind: 'tool_call',
        toolUseId: 'toolu_sub',
        name: 'Grep',
        input: {},
        parentToolUseId: 'toolu_parent',
      },
    ]);
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });
    // `startTool` is this thread's "I am running a tool" state. A delegate's call reaching it drew a
    // spinner in the parent's transcript for work the parent was not doing.
    expect(store.getSnapshot().runningTool).toBeNull();
  });

  it('stores the last context reading so reopening the thread is not blank', async () => {
    const { runner, sessions } = build([
      { kind: 'usage', contextTokens: 40_000, contextLimit: 200_000 },
      { kind: 'usage', contextTokens: 60_000, contextLimit: 200_000 },
    ]);
    await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });
    expect(sessions.recordContextUsage).toHaveBeenCalledTimes(1);
    expect(sessions.recordContextUsage).toHaveBeenCalledWith('session-1', {
      contextTokens: 60_000,
      contextLimit: 200_000,
    });
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

  /**
   * Extra usage and fast mode are per-account permissions, and every one of these is about the
   * difference between a turn Atlas ASKED to be different and one the server merely commented on.
   */
  describe('extra usage and fast mode', () => {
    const allowed = { fastMode: false, extraUsageAllowed: true };

    it('says once that a thread is being billed — not per frame, and not per turn', async () => {
      const { runner, store, accounts } = build([
        { kind: 'extra_usage', inUse: true },
        { kind: 'extra_usage', inUse: true },
      ]);
      accounts.findById.mockResolvedValue(allowed);
      await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });
      await runner.run({ thread: THREAD, session: SESSION, prompt: 'again', cwd: '/repo' });

      // Four frames across two turns. Spending is a STATE, and it entered it once.
      expect(store.getSnapshot().notices).toEqual(['this turn is billed to extra usage']);
    });

    it('announces the fall onto credits once, not at every turn boundary', async () => {
      // The reported bug. `considerRotation` re-decides before EVERY turn, and while the windows
      // stay full it answers `overage` every time — which stacked an identical row per turn.
      const { runner, rotator, store } = build();
      const label = 'dennis@trycomp.ai';
      rotator.considerRotation.mockResolvedValue({
        kind: 'overage',
        from: { id: ACCOUNT_ID, label },
        on: { id: ACCOUNT_ID, label },
      } as never);

      await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });
      await runner.run({ thread: THREAD, session: SESSION, prompt: 'again', cwd: '/repo' });
      await runner.run({ thread: THREAD, session: SESSION, prompt: 'more', cwd: '/repo' });

      expect(store.getSnapshot().notices).toEqual([
        `${label} is out of plan usage · continuing on extra usage`,
      ]);
    });

    it('still speaks when the wallet it lands on is a different account', async () => {
      const { runner, rotator, store } = build();
      rotator.considerRotation.mockResolvedValue({
        kind: 'overage',
        from: { id: ACCOUNT_ID, label: 'first' },
        on: { id: 'account-2', label: 'second' },
      } as never);
      await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

      expect(store.getSnapshot().notices).toEqual([
        'switched to second · every account is out of plan usage · continuing on extra usage',
      ]);
    });

    it('writes a refusal onto the row, so the next boundary does not choose this wallet again', async () => {
      const { runner, accounts } = build([
        { kind: 'extra_usage', inUse: false, disabledReason: 'out_of_credits' },
      ]);
      accounts.findById.mockResolvedValue(allowed);
      await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

      expect(accounts.recordExtraUsage).toHaveBeenCalledWith(ACCOUNT_ID, { enabled: false });
    });

    it('never writes `enabled: true` off a turn that merely worked — the poll owns that', async () => {
      const { runner, accounts } = build([{ kind: 'extra_usage', inUse: true }]);
      accounts.findById.mockResolvedValue(allowed);
      await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

      expect(accounts.recordExtraUsage).not.toHaveBeenCalled();
    });

    it('does not explain extra usage to an account nobody permitted to spend', async () => {
      const { runner, store } = build([
        { kind: 'extra_usage', inUse: false, disabledReason: 'overage_not_provisioned' },
      ]);
      await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

      expect(store.getSnapshot().notices).toEqual([]);
    });

    it('asks for fast mode only when the paying account has it on', async () => {
      const { runner, engine, accounts } = build();
      await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });
      expect(engine.lastArgs?.fastMode).toBe(false);

      accounts.findById.mockResolvedValue({ fastMode: true, extraUsageAllowed: false });
      await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });
      expect(engine.lastArgs?.fastMode).toBe(true);
    });

    it('reports a fast mode that did not take — a silent no-op is indistinguishable from working', async () => {
      const { runner, store, accounts } = build([
        { kind: 'fast_mode', state: 'off', disabledReason: 'model_not_allowed' },
      ]);
      accounts.findById.mockResolvedValue({ fastMode: true, extraUsageAllowed: false });
      await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

      expect(store.getSnapshot().notices).toEqual([
        'fast mode not supported by this model',
      ]);
    });

    it('reports the same refusal exactly once, however many frames and turns carry it', async () => {
      // What this fixes, verbatim: a turn holding for a delegate emits several `result` frames, so
      // `preference` printed twice per turn and again on the next one.
      const { runner, store, accounts } = build([
        { kind: 'fast_mode', state: 'off', disabledReason: 'preference' },
        { kind: 'fast_mode', state: 'off', disabledReason: 'preference' },
      ]);
      accounts.findById.mockResolvedValue({ fastMode: true, extraUsageAllowed: false });
      await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });
      await runner.run({ thread: THREAD, session: SESSION, prompt: 'again', cwd: '/repo' });

      expect(store.getSnapshot().notices).toEqual(['fast mode disabled by your organization']);
    });

    it('speaks again about a refusal that changed, and after fast mode has worked once', async () => {
      const { runner, store, accounts } = build([
        { kind: 'fast_mode', state: 'off', disabledReason: 'network_error' },
        { kind: 'fast_mode', state: 'on' },
        { kind: 'fast_mode', state: 'off', disabledReason: 'network_error' },
      ]);
      accounts.findById.mockResolvedValue({ fastMode: true, extraUsageAllowed: false });
      await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

      expect(store.getSnapshot().notices).toEqual([
        'fast mode unavailable — network trouble',
        'fast mode unavailable — network trouble',
      ]);
    });

    it('stays quiet about fast mode when it was never asked for', async () => {
      // `sdk_opt_in_required` rides EVERY turn of a session that did not opt in. It is the default
      // this feature overrides, not news.
      const { runner, store } = build([
        { kind: 'fast_mode', state: 'off', disabledReason: 'sdk_opt_in_required' },
      ]);
      await runner.run({ thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' });

      expect(store.getSnapshot().notices).toEqual([]);
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

/**
 * A session may hold no credential — a job created before any account existed, or one whose account
 * was forgotten. That is a state, not a failure, so the turn is DECLINED: nothing persisted, no
 * spinner, no ledger row, and the conversation says why until it is resolved.
 */
describe('TurnRunnerService with no account', () => {
  const ARGS = { thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' } as const;
  const NO_ACCOUNT = { ...SESSION, accountId: null } as unknown as typeof SESSION;

  it('declines the turn instead of throwing', async () => {
    const { runner, engine, sessions, sessionManager } = build();
    sessions.currentForThread.mockResolvedValueOnce(NO_ACCOUNT);
    sessionManager.usableAccount.mockResolvedValueOnce(null);

    await expect(runner.run(ARGS)).resolves.toBeUndefined();

    expect(engine.runs).toBe(0);
  });

  it('writes nothing — no message, no turn row, no spinner left running', async () => {
    const { runner, messages, turns, store, sessions, sessionManager } = build();
    sessions.currentForThread.mockResolvedValueOnce(NO_ACCOUNT);
    sessionManager.usableAccount.mockResolvedValueOnce(null);

    await runner.run(ARGS);

    expect(messages.appended).toEqual([]);
    expect(turns.record).not.toHaveBeenCalled();
    expect(store.getSnapshot().running).toBe(false);
  });

  it('shows the reason where the meters would be', async () => {
    const { runner, store, sessions, sessionManager } = build();
    sessions.currentForThread.mockResolvedValueOnce(NO_ACCOUNT);
    sessionManager.usableAccount.mockResolvedValueOnce(null);

    await runner.run(ARGS);

    expect(store.getSnapshot().noAccount).toMatch(/ctrl\+a/);
  });

  /**
   * The resolution half: a session holding none takes the account the pool offers and KEEPS it, so the
   * meters, the chip and the ledger all name the same one for the work that follows.
   */
  it('resolves an account onto the session and stamps it', async () => {
    const { runner, engine, sessions, store } = build();
    sessions.currentForThread.mockResolvedValueOnce(NO_ACCOUNT);

    await runner.run(ARGS);

    expect(sessions.setAccount).toHaveBeenCalledWith({
      sessionId: SESSION.id,
      accountId: ACCOUNT_ID,
    });
    expect(engine.runs).toBe(1);
    expect(store.getSnapshot().noAccount).toBeNull();
  });

  it('clears a stale notice once an account exists again', async () => {
    const { runner, store } = build();
    store.setNoAccount('no claude account yet — press ctrl+a to add one');

    await runner.run(ARGS);

    expect(store.getSnapshot().noAccount).toBeNull();
  });
});

/**
 * The engine refreshes the credentials file Atlas hands it, in place, and the server rotates the
 * refresh token as it does — so the pair Atlas stored stops working the moment the engine beats it to
 * a refresh. Reading the file back at the end of every turn is what keeps the two in step; without it
 * the next refresh Atlas attempts fails with a 4xx and marks a live account dead.
 */
describe('TurnRunnerService credential read-back', () => {
  const ARGS = { thread: THREAD, session: SESSION, prompt: 'go', cwd: '/repo' } as const;
  const ROTATED = {
    claudeAiOauth: { accessToken: 'oat-2', refreshToken: 'ort-2', expiresAt: 9_000, scopes: [] },
  };

  it('adopts the credential the engine refreshed, for the account that ran the turn', async () => {
    const { runner, vault, homes } = build();
    homes.observeClaudeCredential.mockReturnValue(ROTATED);

    await runner.run(ARGS);

    expect(homes.observeClaudeCredential).toHaveBeenCalledWith(SESSION.accountId);
    expect(vault.adopt).toHaveBeenCalledWith({
      accountId: SESSION.accountId,
      observed: ROTATED,
    });
  });

  it('writes nothing when the engine left the file as Atlas wrote it', async () => {
    const { runner, vault } = build();

    await runner.run(ARGS);

    expect(vault.adopt).not.toHaveBeenCalled();
  });

  /**
   * A crashed turn is exactly when this matters most: the engine may have refreshed the credential
   * and THEN failed, and losing that pair is what leaves the account unusable afterwards.
   */
  it('adopts even when the turn failed', async () => {
    const { runner, vault, homes, engine } = build();
    homes.observeClaudeCredential.mockReturnValue(ROTATED);
    engine.start = () => {
      throw new Error('engine died');
    };

    await expect(runner.run(ARGS)).rejects.toThrow('engine died');

    expect(vault.adopt).toHaveBeenCalledTimes(1);
  });

  it('does not fail a turn because the adoption failed', async () => {
    const { runner, vault, homes, store } = build();
    homes.observeClaudeCredential.mockReturnValue(ROTATED);
    vault.adopt.mockRejectedValueOnce(new Error('database is locked'));

    await expect(runner.run(ARGS)).resolves.toBeUndefined();
    expect(store.getSnapshot().running).toBe(false);
  });
});
