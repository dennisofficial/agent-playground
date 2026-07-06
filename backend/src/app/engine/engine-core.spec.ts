import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeSessionExists, EngineCore, extractClaudeUsage } from './engine-core';
import { atlasEngineHomeDir } from './engine-home';
import { isUnresumableSessionMessage, UNRESUMABLE_SESSION_MARKER } from './engine.types';
import type { EngineEvent } from './engine.types';

const HOME_ROOT = join(tmpdir(), `atlas-engine-core-spec-${process.pid}`);
afterAll(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

/** A fake Claude SDK whose `query` records the options it was called with and yields a success. */
function fakeClaudeSdk() {
  const captured: { prompt?: string; options?: Record<string, unknown> } = {};
  const sdk = {
    query: ({ prompt, options }: { prompt: string; options: Record<string, unknown> }) => {
      captured.prompt = prompt;
      captured.options = options;
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-1',
          result: 'done',
          usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2 },
          total_cost_usd: 0.01,
        };
      })();
    },
  } as unknown as typeof import('@anthropic-ai/claude-agent-sdk');
  return { sdk, captured };
}

/** A fake Claude SDK that yields the FULL rich stream: token deltas + thinking + tool_use/tool_result. */
function fakeRichClaudeSdk() {
  const captured: { options?: Record<string, unknown> } = {};
  const sdk = {
    query: ({ options }: { prompt: string; options: Record<string, unknown> }) => {
      captured.options = options;
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
        yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } };
        yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } };
        yield {
          type: 'assistant',
          message: {
            content: [
              { type: 'thinking', thinking: 'full thought' },
              { type: 'text', text: 'Hello' },
              { type: 'tool_use', id: 'tu1', name: 'Read', input: { path: 'README.md' } },
            ],
          },
        };
        yield {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file contents', is_error: false }] },
        };
        yield { type: 'result', subtype: 'success', session_id: 'sess-1', result: 'Hello', usage: { input_tokens: 1, output_tokens: 1 } };
      })();
    },
  } as unknown as typeof import('@anthropic-ai/claude-agent-sdk');
  return { sdk, captured };
}

/**
 * A fake Claude SDK that streams MULTIPLE main-agent round-trips (each `assistant` message carries its
 * OWN per-call usage), one interleaved SUBAGENT message (parent_tool_use_id set, helper model), then a
 * `result` whose usage is the CUMULATIVE sum. Used to prove context occupancy reads the last MAIN call's
 * per-call size, not the cumulative billing total.
 */
function fakeMultiTurnClaudeSdk() {
  const sdk = {
    query: () =>
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
        // Round-trip 1 (main): context = 50 + 10000 + 2000 = 12050.
        yield {
          type: 'assistant',
          message: {
            model: 'claude-opus-4-8',
            usage: { input_tokens: 50, cache_read_input_tokens: 10000, cache_creation_input_tokens: 2000 },
            content: [{ type: 'tool_use', id: 'tu1', name: 'Task', input: {} }],
          },
        };
        // A SUBAGENT round-trip (helper model, parent set) — MUST be ignored for occupancy.
        yield {
          type: 'assistant',
          parent_tool_use_id: 'tu1',
          message: {
            model: 'claude-haiku-4-5',
            usage: { input_tokens: 5, cache_read_input_tokens: 999999 },
            content: [{ type: 'text', text: 'sub' }],
          },
        };
        // Round-trip 2 (main, LAST): context = 80 + 23000 + 1000 = 24080.
        yield {
          type: 'assistant',
          message: {
            model: 'claude-opus-4-8',
            usage: { input_tokens: 80, cache_read_input_tokens: 23000, cache_creation_input_tokens: 1000 },
            content: [{ type: 'text', text: 'done' }],
          },
        };
        // Cumulative billing usage (sums every round-trip's cache re-reads): inputTokens = 100+180000+6000.
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-1',
          result: 'done',
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 180000,
            cache_creation_input_tokens: 6000,
          },
          total_cost_usd: 0.21,
        };
      })(),
  } as unknown as typeof import('@anthropic-ai/claude-agent-sdk');
  return { sdk };
}

/** A fake Codex SDK capturing constructor opts + thread options. */
function fakeCodexSdk() {
  const ctorCalls: Array<Record<string, unknown>> = [];
  const threadCalls: Array<Record<string, unknown>> = [];
  class FakeCodex {
    constructor(opts: Record<string, unknown>) {
      ctorCalls.push(opts);
    }
    startThread(opts: Record<string, unknown>) {
      threadCalls.push(opts);
      return {
        id: 'thread-1',
        runStreamed: async () => ({
          events: (async function* () {
            yield { type: 'thread.started', job_id: 'thread-1' };
            yield { type: 'item.completed', item: { type: 'agent_message', text: 'codex done' } };
            yield { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 3 } };
          })(),
        }),
      };
    }
    resumeThread(_id: string, opts: Record<string, unknown>) {
      return this.startThread(opts);
    }
  }
  const sdk = { Codex: FakeCodex } as unknown as typeof import('@openai/codex-sdk');
  return { sdk, ctorCalls, threadCalls };
}

/** A complete ChatGPT-plan `auth.json` blob (passes `assertValidCodexAuthJson`). */
function codexAuthBlob(lastRefresh: string, accessToken = 'a'): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: { id_token: 'i', access_token: accessToken, refresh_token: 'r' },
    last_refresh: lastRefresh,
  });
}
const VALID_CODEX_AUTH = codexAuthBlob('2026-07-01T00:00:00.000Z');

/**
 * A fake Codex SDK that, on `runStreamed`, overwrites its CODEX_HOME `auth.json` with `refreshedBlob`
 * (simulating an in-place token refresh) — or leaves it untouched when `refreshedBlob` is null.
 */
function fakeRefreshingCodexSdk(refreshedBlob: string | null) {
  let codexHome: string | undefined;
  class FakeCodex {
    constructor(opts: Record<string, unknown>) {
      codexHome = (opts.env as Record<string, string> | undefined)?.CODEX_HOME;
    }
    startThread() {
      return {
        id: 'thread-1',
        runStreamed: async () => {
          if (refreshedBlob !== null && codexHome) {
            writeFileSync(join(codexHome, 'auth.json'), refreshedBlob);
          }
          return {
            events: (async function* () {
              yield { type: 'thread.started', job_id: 'thread-1' };
              yield { type: 'item.completed', item: { type: 'agent_message', text: 'codex done' } };
              yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
            })(),
          };
        },
      };
    }
    resumeThread() {
      return this.startThread();
    }
  }
  return { Codex: FakeCodex } as unknown as typeof import('@openai/codex-sdk');
}

describe('EngineCore — Claude mode/home/credential wiring', () => {
  it('execute mode: write tools, default permission, isolated CLAUDE_CONFIG_DIR, subscription token threaded', async () => {
    const { sdk, captured } = fakeClaudeSdk();
    const core = new EngineCore(sdk, fakeCodexSdk().sdk, { homeRoot: HOME_ROOT, claudeOauthToken: 'cfg-oauth', codexOauthToken: 'cfg-codex' });
    const res = await core.run({
      engine: 'claude',
      task: 'do it',
      cwd: '/tmp/wt',
      systemPrompt: 'persona',
      sandboxKey: 'acme--feat',
      mode: 'execute',
      auth: { secret: 'oauth-tok' },
      model: 'claude-x',
    });
    const opts = captured.options!;
    expect(opts.permissionMode).toBe('default');
    expect(opts.tools).toContain('Write');
    expect(opts.tools).toContain('Edit');
    expect(opts.model).toBe('claude-x');
    // Isolated home, NOT ~/.claude.
    const env = opts.env as Record<string, string>;
    expect(env.CLAUDE_CONFIG_DIR).toContain(HOME_ROOT);
    expect(env.CLAUDE_CONFIG_DIR).toContain('claude');
    expect(env.CLAUDE_CONFIG_DIR).not.toContain('/.claude');
    // Subscription token threaded into the SUBPROCESS env (any ambient API key is stripped at the seam).
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-tok');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    // settingSources [] = full isolation (no on-disk config files read).
    expect(opts.settingSources).toEqual([]);
    // Result + usage surfaced.
    expect(res.result).toBe('done');
    expect(res.sessionId).toBe('sess-1');
    expect(res.usage).toMatchObject({ inputTokens: 12, outputTokens: 4, costUsd: 0.01 });
  });

  it('writer subagents (implement/implement-deep) are spawnable ONLY on execute turns, not plan/review', async () => {
    const run = async (mode: 'execute' | 'plan' | 'review') => {
      const { sdk, captured } = fakeClaudeSdk();
      const core = new EngineCore(sdk, fakeCodexSdk().sdk, { homeRoot: HOME_ROOT, claudeOauthToken: 'o', codexOauthToken: 'c' });
      await core.run({ engine: 'claude', task: 't', cwd: '/tmp/wt', systemPrompt: 'p', sandboxKey: 'a--b', mode, auth: { secret: 'tok' } });
      return captured.options!.agents as Record<string, { tools: string[]; model: string }>;
    };

    const execAgents = await run('execute');
    // Writers present, Sonnet 5 default + Opus escalation, can Write/Edit/Bash, and have NO Task (no recursive fan-out).
    expect(execAgents.implement).toBeDefined();
    expect(execAgents['implement-deep']).toBeDefined();
    expect(execAgents.implement.model).toBe('claude-sonnet-5');
    expect(execAgents['implement-deep'].model).toBe('opus');
    for (const w of [execAgents.implement, execAgents['implement-deep']]) {
      expect(w.tools).toEqual(expect.arrayContaining(['Write', 'Edit', 'Bash']));
      expect(w.tools).not.toContain('Task');
    }
    // The advisory read-only subagent is still there.
    expect(execAgents.explore).toBeDefined();

    // The build-time `validate` subagent: execute-only, Sonnet, Bash + Write (to author the evidence
    // bundle) but NO Task (no recursive fan-out). Its "write only under /context/artifacts" contract is
    // prompt discipline, NOT enforced here — the write boundary is per-turn (see the canUseTool test).
    expect(execAgents.validate).toBeDefined();
    expect(execAgents.validate.model).toBe('claude-sonnet-5');
    expect(execAgents.validate.tools).toEqual(expect.arrayContaining(['Bash', 'Write']));
    expect(execAgents.validate.tools).not.toContain('Task');

    // Plan + review turns get ONLY the advisory set — no writers or validator can be spawned.
    for (const mode of ['plan', 'review'] as const) {
      const agents = await run(mode);
      expect(agents.explore).toBeDefined();
      expect(agents.implement).toBeUndefined();
      expect(agents['implement-deep']).toBeUndefined();
      expect(agents.validate).toBeUndefined();
    }
  });

  it('execute mode: canUseTool allows Write inside cwd OR a writableRoot, denies elsewhere', async () => {
    const { sdk, captured } = fakeClaudeSdk();
    const core = new EngineCore(sdk, fakeCodexSdk().sdk, { homeRoot: HOME_ROOT, claudeOauthToken: 'cfg-oauth', codexOauthToken: 'cfg-codex' });
    await core.run({
      engine: 'claude',
      task: 'do it',
      cwd: '/workspace',
      systemPrompt: 'persona',
      sandboxKey: 'acme--feat',
      mode: 'execute',
      // The durable `/context` shared mount the docker runner grants so the brain can author the plan.
      writableRoots: ['/context'],
    });
    const canUseTool = captured.options!.canUseTool as (
      name: string,
      input: Record<string, unknown>,
    ) => Promise<{ behavior: string }>;
    // Inside the worktree → allowed.
    expect(await canUseTool('Write', { file_path: '/workspace/src/x.ts' })).toMatchObject({ behavior: 'allow' });
    // Inside the extra writable root (`/context`) → allowed (was the Bash-fallback bug).
    expect(await canUseTool('Write', { file_path: '/context/specs/plan.md' })).toMatchObject({ behavior: 'allow' });
    expect(await canUseTool('Edit', { file_path: '/context/artifacts/preview.html' })).toMatchObject({ behavior: 'allow' });
    // Outside both → denied.
    expect(await canUseTool('Write', { file_path: '/etc/passwd' })).toMatchObject({ behavior: 'deny' });
  });

  it('plan mode: permissionMode plan, ExitPlanMode tool present, no writes flag in canUseTool', async () => {
    const { sdk, captured } = fakeClaudeSdk();
    const core = new EngineCore(sdk, fakeCodexSdk().sdk, { homeRoot: HOME_ROOT, claudeOauthToken: 'cfg-oauth', codexOauthToken: 'cfg-codex' });
    await core.run({
      engine: 'claude',
      task: 'plan it',
      cwd: '/tmp/wt',
      systemPrompt: 'persona',
      sandboxKey: 'acme--feat',
      mode: 'plan',
    });
    const opts = captured.options!;
    expect(opts.permissionMode).toBe('plan');
    expect(opts.tools).toContain('ExitPlanMode');
  });

  it('review mode: read-only tool set, default permission, no Write/Edit', async () => {
    const { sdk, captured } = fakeClaudeSdk();
    const core = new EngineCore(sdk, fakeCodexSdk().sdk, { homeRoot: HOME_ROOT, claudeOauthToken: 'cfg-oauth', codexOauthToken: 'cfg-codex' });
    await core.run({
      engine: 'claude',
      task: 'review it',
      cwd: '/tmp/wt',
      systemPrompt: 'persona',
      sandboxKey: 'acme--feat',
      mode: 'review',
    });
    const opts = captured.options!;
    expect(opts.tools).not.toContain('Write');
    expect(opts.tools).not.toContain('Edit');
    expect(opts.tools).toContain('Read');
  });

  it('richStream: enables partial stream + thinking, emits token deltas, thinking, tool_use(input) + tool_result', async () => {
    const { sdk, captured } = fakeRichClaudeSdk();
    const core = new EngineCore(sdk, fakeCodexSdk().sdk, { homeRoot: HOME_ROOT, claudeOauthToken: 'cfg-oauth', codexOauthToken: 'cfg-codex' });
    const events: EngineEvent[] = [];
    await core.run({
      engine: 'claude',
      task: 'x',
      cwd: '/tmp/wt',
      systemPrompt: 'p',
      sandboxKey: 'k',
      mode: 'execute',
      richStream: true,
      onEvent: (e) => events.push(e),
    });
    const opts = captured.options!;
    expect(opts.includePartialMessages).toBe(true);
    expect(opts.thinking).toMatchObject({ type: 'adaptive' });

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['text_delta', 'thinking_delta', 'thinking', 'text', 'tool_use', 'tool_result']),
    );
    const toolUse = events.find((e) => e.kind === 'tool_use') as Extract<EngineEvent, { kind: 'tool_use' }>;
    expect(toolUse).toMatchObject({ id: 'tu1', name: 'Read' });
    expect(toolUse.input).toMatchObject({ path: 'README.md' });
    const toolResult = events.find((e) => e.kind === 'tool_result') as Extract<EngineEvent, { kind: 'tool_result' }>;
    expect(toolResult).toMatchObject({ id: 'tu1', result: 'file contents', isError: false });
  });

  it('richStream: forwards an Edit `tool_use_result.structuredPatch` (real file offsets) onto tool_result', async () => {
    const hunks = [{ oldStart: 79, oldLines: 7, newStart: 79, newLines: 8, lines: [' a', '-b', '+c', '+d'] }];
    const sdk = {
      query: () =>
        (async function* () {
          yield { type: 'system', subtype: 'init', session_id: 's' };
          yield {
            type: 'assistant',
            message: { content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'x.md' } }] },
          };
          yield {
            type: 'user',
            tool_use_result: { structuredPatch: hunks },
            message: { content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'updated', is_error: false }] },
          };
          yield { type: 'result', subtype: 'success', session_id: 's', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } };
        })(),
    } as unknown as typeof import('@anthropic-ai/claude-agent-sdk');
    const core = new EngineCore(sdk, fakeCodexSdk().sdk, { homeRoot: HOME_ROOT, claudeOauthToken: 'cfg-oauth', codexOauthToken: 'cfg-codex' });
    const events: EngineEvent[] = [];
    await core.run({ engine: 'claude', task: 'x', cwd: '/tmp/wt', systemPrompt: 'p', sandboxKey: 'k', mode: 'execute', richStream: true, onEvent: (e) => events.push(e) });

    const toolResult = events.find((e) => e.kind === 'tool_result') as Extract<EngineEvent, { kind: 'tool_result' }>;
    expect(toolResult.structuredPatch).toEqual(hunks);
  });

  it('non-success result: throw carries the subtype AND the SDKResultError detail + stderr tail', async () => {
    const sdk = {
      query: ({ options }: { prompt: string; options: Record<string, unknown> }) => {
        // The SDK routes subprocess stderr through options.stderr; the real cause lives here.
        (options.stderr as (d: string) => void)?.('API Error: 529 overloaded_error\n');
        return (async function* () {
          yield { type: 'system', subtype: 'init', session_id: 's' };
          yield {
            type: 'result',
            subtype: 'error_during_execution',
            session_id: 's',
            stop_reason: 'refusal',
            errors: ['boom: upstream failed'],
            usage: { input_tokens: 1, output_tokens: 0 },
          };
        })();
      },
    } as unknown as typeof import('@anthropic-ai/claude-agent-sdk');
    const core = new EngineCore(sdk, fakeCodexSdk().sdk, { homeRoot: HOME_ROOT, claudeOauthToken: 'o', codexOauthToken: 'c' });
    await expect(
      core.run({ engine: 'claude', task: 'x', cwd: '/tmp/wt', systemPrompt: 'p', sandboxKey: 'k', mode: 'execute' }),
    ).rejects.toThrow(/Claude engine ended: error_during_execution.*stop_reason=refusal.*errors=boom: upstream failed.*stderr\(tail\)=.*529 overloaded_error/s);
  });

  it('without richStream: no partial stream; tool stays name-only; no thinking/tool_result', async () => {
    const { sdk, captured } = fakeRichClaudeSdk();
    const core = new EngineCore(sdk, fakeCodexSdk().sdk, { homeRoot: HOME_ROOT, claudeOauthToken: 'cfg-oauth', codexOauthToken: 'cfg-codex' });
    const events: EngineEvent[] = [];
    await core.run({
      engine: 'claude',
      task: 'x',
      cwd: '/tmp/wt',
      systemPrompt: 'p',
      sandboxKey: 'k',
      mode: 'execute',
      onEvent: (e) => events.push(e),
    });
    expect(captured.options!.includePartialMessages).toBeUndefined();
    expect(captured.options!.thinking).toBeUndefined();
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('text');
    expect(kinds).toContain('tool'); // legacy name-only tool event
    expect(kinds).not.toContain('tool_use');
    expect(kinds).not.toContain('thinking');
    expect(kinds).not.toContain('tool_result');
  });

  it('steerable: runs streaming-input mode — delivers the task, then injects a steer with priority:now', async () => {
    // A fake SDK that CONSUMES the prompt iterable (streaming-input mode): reads the task, finishes a
    // round-trip, then reads a second message (the injected steer) and finishes a steered round-trip.
    const seen: Array<{ type?: string; message?: { content?: unknown }; priority?: string }> = [];
    const sdk = {
      query: ({ prompt }: { prompt: AsyncIterable<{ type: string }> }) =>
        (async function* () {
          const iter = prompt[Symbol.asyncIterator]();
          const first = await iter.next();
          seen.push(first.value as (typeof seen)[number]);
          yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
          // First committed assistant message ⇒ the engine flushes any HELD steer (a steer that arrives
          // before this point is buffered — injecting priority:'now' pre-stream aborts the turn).
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] }, session_id: 'sess-1' };
          yield { type: 'result', subtype: 'success', session_id: 'sess-1', result: 'r1', usage: { input_tokens: 1, output_tokens: 1 } };
          const second = await iter.next(); // the steer, injected once the turn is streaming
          if (!second.done) {
            seen.push(second.value as (typeof seen)[number]);
            yield { type: 'result', subtype: 'success', session_id: 'sess-1', result: 'r2', usage: { input_tokens: 1, output_tokens: 1 } };
          }
        })(),
    } as unknown as typeof import('@anthropic-ai/claude-agent-sdk');

    // The live steer source: one operator steer, then it ends (the turn's own lifecycle closes input).
    const steerInput: AsyncIterable<{ text: string }> = {
      async *[Symbol.asyncIterator]() {
        yield { text: 'focus on the API layer' };
      },
    };

    const core = new EngineCore(sdk, fakeCodexSdk().sdk, { homeRoot: HOME_ROOT, claudeOauthToken: 'o', codexOauthToken: 'c' });
    const res = await core.run({
      engine: 'claude',
      task: 'do the thing',
      cwd: '/tmp/wt',
      systemPrompt: 'p',
      sandboxKey: 'k',
      mode: 'execute',
      steerable: true,
      steerInput,
    });

    // The initial prompt message is the task; the second is the steer, tagged priority:'now'.
    expect(seen[0]).toMatchObject({ type: 'user', message: { role: 'user', content: 'do the thing' } });
    expect(seen[1]).toMatchObject({ type: 'user', message: { role: 'user', content: 'focus on the API layer' }, priority: 'now' });
    // The steered continuation's result wins.
    expect(res.result).toBe('r2');
  });

  it('steerable: emits input_ack for a steer carrying an id, and dedupes a redelivered id (no double-push, still re-acks)', async () => {
    // The SDK consumes the task, emits a first assistant message (flushing the held steer), then reads the
    // injected steer. The steer's redelivery is gated to arrive AFTER injection (a lost-ack re-drive).
    const pushed: unknown[] = [];
    const sdk = {
      query: ({ prompt }: { prompt: AsyncIterable<{ type: string; message?: { content?: unknown } }> }) =>
        (async function* () {
          const iter = prompt[Symbol.asyncIterator]();
          const first = await iter.next();
          pushed.push((first.value as { message?: { content?: unknown } }).message?.content);
          yield { type: 'system', subtype: 'init', session_id: 's' };
          // First assistant message ⇒ flush the held steer so it injects (subtype=success regime).
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] }, session_id: 's' };
          yield { type: 'result', subtype: 'success', session_id: 's', result: 'r1', usage: { input_tokens: 1, output_tokens: 1 } };
          // The injected steer (id S1) is read exactly once; the redelivery is a no-op push (still re-acks).
          const a = await iter.next();
          if (!a.done) pushed.push((a.value as { message?: { content?: unknown } }).message?.content);
          yield { type: 'result', subtype: 'success', session_id: 's', result: 'r2', usage: { input_tokens: 1, output_tokens: 1 } };
        })(),
    } as unknown as typeof import('@anthropic-ai/claude-agent-sdk');

    // Two steers with the SAME id (the second is a lost-ack re-drive). The redelivery is gated to fire only
    // AFTER the first has been injected+acked, so it hits the "already injected → re-ack, never re-push" path.
    let releaseRedelivery: () => void = () => {};
    const redeliveryGate = new Promise<void>((r) => {
      releaseRedelivery = r;
    });
    const steerInput: AsyncIterable<{ id?: string; text: string }> = {
      async *[Symbol.asyncIterator]() {
        yield { id: 'S1', text: 'do X' };
        await redeliveryGate;
        yield { id: 'S1', text: 'do X' };
      },
    };

    const acks: string[] = [];
    const core = new EngineCore(sdk, fakeCodexSdk().sdk, { homeRoot: HOME_ROOT, claudeOauthToken: 'o', codexOauthToken: 'c' });
    await core.run({
      engine: 'claude',
      task: 'the task',
      cwd: '/tmp/wt',
      systemPrompt: 'p',
      sandboxKey: 'k',
      mode: 'execute',
      steerable: true,
      steerInput,
      onEvent: (e) => {
        if (e.kind === 'input_ack') {
          acks.push(e.id);
          if (acks.length === 1) releaseRedelivery(); // first ack landed → let the redelivery re-drive
        }
      },
    });

    // The task is pushed once; the steer id S1 is pushed exactly ONCE (the redelivery is a no-op push)...
    expect(pushed).toEqual(['the task', 'do X']);
    // ...but BOTH deliveries of S1 emit an ack, so a lost-ack re-drive still converges to delivered.
    expect(acks).toEqual(['S1', 'S1']);
  });

  it('steerable: HOLDS a steer that arrives before the first assistant message, then injects it on flush', async () => {
    // The startup-race guard: a priority:'now' steer pushed before the model commits its first assistant
    // message aborts the turn. So a steer arriving pre-stream must be HELD (not pushed, not acked) until the
    // first `assistant` message; only then is it injected + acked. Here the steer is available immediately,
    // but the SDK reads the injected message (and emits the ack) ONLY after the assistant message is yielded.
    const pushedAfterEachStage: { beforeAssistant: unknown[]; afterAssistant: unknown[] } = {
      beforeAssistant: [],
      afterAssistant: [],
    };
    const acks: string[] = [];
    let sawAssistant = false;
    const sdk = {
      query: ({ prompt }: { prompt: AsyncIterable<{ type: string; message?: { content?: unknown } }> }) =>
        (async function* () {
          const iter = prompt[Symbol.asyncIterator]();
          await iter.next(); // the task
          yield { type: 'system', subtype: 'init', session_id: 's' };
          // The steer is present on steerInput already, but must be HELD — no ack yet.
          await new Promise((r) => setTimeout(r, 5));
          if (acks.length !== 0) throw new Error('steer was acked BEFORE the first assistant message (not held)');
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] }, session_id: 's' };
          sawAssistant = true;
          const injected = await iter.next(); // now the flushed steer arrives
          pushedAfterEachStage.afterAssistant.push((injected.value as { message?: { content?: unknown } }).message?.content);
          yield { type: 'result', subtype: 'success', session_id: 's', result: 'done', usage: { input_tokens: 1, output_tokens: 1 } };
        })(),
    } as unknown as typeof import('@anthropic-ai/claude-agent-sdk');

    const steerInput: AsyncIterable<{ id?: string; text: string }> = {
      async *[Symbol.asyncIterator]() {
        yield { id: 'S9', text: 'held steer' };
      },
    };

    const core = new EngineCore(sdk, fakeCodexSdk().sdk, { homeRoot: HOME_ROOT, claudeOauthToken: 'o', codexOauthToken: 'c' });
    await core.run({
      engine: 'claude',
      task: 'the task',
      cwd: '/tmp/wt',
      systemPrompt: 'p',
      sandboxKey: 'k',
      mode: 'execute',
      steerable: true,
      steerInput,
      onEvent: (e) => {
        if (e.kind === 'input_ack') acks.push(e.id);
      },
    });

    // The steer was injected (and acked) ONLY after the assistant message — never before.
    expect(sawAssistant).toBe(true);
    expect(pushedAfterEachStage.afterAssistant).toEqual(['held steer']);
    expect(acks).toEqual(['S9']);
  });

  it('surfaces per-call context occupancy (NOT the cumulative billing sum) across multiple round-trips', async () => {
    const { sdk } = fakeMultiTurnClaudeSdk();
    const core = new EngineCore(sdk, fakeCodexSdk().sdk, { homeRoot: HOME_ROOT, claudeOauthToken: 'o', codexOauthToken: 'c' });
    const res = await core.run({
      engine: 'claude',
      task: 'x',
      cwd: '/tmp/wt',
      systemPrompt: 'p',
      sandboxKey: 'k',
      mode: 'execute',
      auth: { secret: 'tok' },
    });
    const usage = res.usage!;
    // Billing stays the CUMULATIVE total (fresh + all cache reads/writes across every round-trip).
    expect(usage.inputTokens).toBe(100 + 180000 + 6000); // 186100
    // Occupancy is the LAST MAIN round-trip's single-call context size — NOT the cumulative sum, and
    // NOT the interleaved subagent's bloated cache read.
    expect(usage.contextTokens).toBe(80 + 23000 + 1000); // 24080
    expect(usage.contextTokens).not.toBe(usage.inputTokens);
    // The occupancy model is the MAIN agent's (opus), never the helper subagent (haiku).
    expect(usage.contextModel).toBe('claude-opus-4-8');
  });

  it('falls back to the env subscription token and strips any ambient API key', async () => {
    const { sdk, captured } = fakeClaudeSdk();
    const prior = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'should-be-stripped';
    try {
      const core = new EngineCore(sdk, fakeCodexSdk().sdk, {
        homeRoot: HOME_ROOT,
        claudeOauthToken: 'oauth-from-env',
      });
      await core.run({
        engine: 'claude',
        task: 'x',
        cwd: '/tmp/wt',
        systemPrompt: 'p',
        sandboxKey: 'k',
        mode: 'execute',
        // no explicit auth → falls back to cfg.claudeOauthToken
      });
      const env = captured.options!.env as Record<string, string>;
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-from-env');
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prior;
    }
  });

  it('throws (no API-key fallback) when no subscription secret is available', async () => {
    const { sdk } = fakeClaudeSdk();
    const core = new EngineCore(sdk, fakeCodexSdk().sdk, { homeRoot: HOME_ROOT });
    await expect(
      core.run({
        engine: 'claude',
        task: 'x',
        cwd: '/tmp/wt',
        systemPrompt: 'p',
        sandboxKey: 'k',
        mode: 'execute',
        // no explicit auth, no cfg.claudeOauthToken
      }),
    ).rejects.toThrow(/subscription secret/);
  });

  it('tool bridge: server registered under options.mcpServers (not a stray top-level key); names auto-approved', async () => {
    const { sdk, captured } = fakeClaudeSdk();
    const core = new EngineCore(sdk, fakeCodexSdk().sdk, { homeRoot: HOME_ROOT, claudeOauthToken: 'cfg-oauth', codexOauthToken: 'cfg-codex' });
    const mcpServers = { 'atlas-host-bridge': { __fake: 'server' } };
    const names = ['mcp__atlas-host-bridge__submit_plan', 'mcp__atlas-host-bridge__get_pipeline_state'];
    await core.runWithExtras(
      { engine: 'claude', task: 'x', cwd: '/tmp/wt', systemPrompt: 'p', sandboxKey: 'k', mode: 'execute' },
      { mcpServers },
      names,
    );
    const opts = captured.options!;
    // The bridge server reaches the SDK under the `mcpServers` option — the bug spread the raw map so
    // it landed as a stray top-level `Options['atlas-host-bridge']` and never registered.
    expect(opts.mcpServers).toBe(mcpServers);
    expect(opts).not.toHaveProperty('atlas-host-bridge');
    // Qualified MCP tool names are auto-approved alongside the read tools.
    expect(opts.allowedTools).toEqual(expect.arrayContaining(['Read', 'Glob', 'Grep', ...names]));
  });

  it('no bridge: allowedTools is the static auto-approve set and no mcpServers leak (worker invariant)', async () => {
    const { sdk, captured } = fakeClaudeSdk();
    const core = new EngineCore(sdk, fakeCodexSdk().sdk, { homeRoot: HOME_ROOT, claudeOauthToken: 'cfg-oauth', codexOauthToken: 'cfg-codex' });
    await core.run({
      engine: 'claude',
      task: 'x',
      cwd: '/tmp/wt',
      systemPrompt: 'p',
      sandboxKey: 'k',
      mode: 'execute',
    });
    const opts = captured.options!;
    // Auto-approve: safe reads + subagent spawning + the task tools (live task list) + web. Writes/Bash
    // still fall through to canUseTool.
    expect(opts.allowedTools).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Task',
      'TaskCreate',
      'TaskUpdate',
      'TaskList',
      'TaskGet',
      'WebSearch',
      'WebFetch',
    ]);
    expect(opts.mcpServers).toBeUndefined();
  });
});

describe('EngineCore — Codex mode/home/credential wiring', () => {
  it('execute mode: danger-full-access sandbox, subscription auth.json home, NO apiKey on the client', async () => {
    const { sdk, ctorCalls, threadCalls } = fakeCodexSdk();
    const core = new EngineCore(fakeClaudeSdk().sdk, sdk, { homeRoot: HOME_ROOT, claudeOauthToken: 'cfg-oauth', codexOauthToken: 'cfg-codex' });
    const res = await core.run({
      engine: 'codex',
      task: 'do it',
      cwd: '/tmp/wt',
      systemPrompt: 'persona',
      sandboxKey: 'acme--feat',
      mode: 'execute',
      auth: { secret: VALID_CODEX_AUTH },
    });
    // Subscription-only: the CLI reads auth.json from CODEX_HOME, so NO apiKey is passed to the client.
    expect(ctorCalls[0].apiKey).toBeUndefined();
    const ctorEnv = ctorCalls[0].env as Record<string, string>;
    expect(ctorEnv.CODEX_HOME).toContain(HOME_ROOT);
    expect(ctorEnv.CODEX_HOME).not.toContain('/.codex/');
    expect(threadCalls[0].sandboxMode).toBe('danger-full-access');
    expect(res.result).toBe('codex done');
    expect(res.sessionId).toBe('thread-1');
    expect(res.usage).toMatchObject({ inputTokens: 5, outputTokens: 3 });
  });

  it('plan mode: danger-full-access sandbox (network for doc-checking; no-edit is prompt-enforced)', async () => {
    const { sdk, threadCalls } = fakeCodexSdk();
    const core = new EngineCore(fakeClaudeSdk().sdk, sdk, { homeRoot: HOME_ROOT, claudeOauthToken: 'cfg-oauth', codexOauthToken: 'cfg-codex' });
    await core.run({
      engine: 'codex',
      task: 'plan it',
      cwd: '/tmp/wt',
      systemPrompt: 'persona',
      sandboxKey: 'acme--feat',
      mode: 'plan',
      auth: { secret: VALID_CODEX_AUTH },
    });
    expect(threadCalls[0].sandboxMode).toBe('danger-full-access');
  });

  it('richStream: a file_change item derives a real structuredPatch from the git worktree (Codex reports no diff content itself)', async () => {
    const wt = join(tmpdir(), `atlas-engine-core-codex-diff-${process.pid}`);
    rmSync(wt, { recursive: true, force: true });
    mkdirSync(wt, { recursive: true });
    const git = (...cmdArgs: string[]) => execFileSync('git', cmdArgs, { cwd: wt });
    git('init', '-q');
    git('config', 'user.email', 'a@b.c');
    git('config', 'user.name', 'a');
    writeFileSync(join(wt, 'x.md'), 'line1\nline2\nline3\n');
    git('add', 'x.md');
    git('commit', '-q', '-m', 'init');
    // Codex has already applied the edit to disk by the time `file_change` is reported.
    writeFileSync(join(wt, 'x.md'), 'line1\nCHANGED\nline3\n');

    class FakeCodex {
      constructor() {}
      startThread() {
        return {
          id: 'thread-1',
          runStreamed: async () => ({
            events: (async function* () {
              yield { type: 'thread.started', job_id: 'thread-1' };
              yield {
                type: 'item.completed',
                item: { id: 'fc1', type: 'file_change', status: 'completed', changes: [{ path: 'x.md', kind: 'update' }] },
              };
              yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
            })(),
          }),
        };
      }
    }
    const sdk = { Codex: FakeCodex } as unknown as typeof import('@openai/codex-sdk');
    const core = new EngineCore(fakeClaudeSdk().sdk, sdk, { homeRoot: HOME_ROOT, claudeOauthToken: 'cfg-oauth', codexOauthToken: 'cfg-codex' });
    const events: EngineEvent[] = [];
    try {
      await core.run({
        engine: 'codex',
        task: 'edit it',
        cwd: wt,
        systemPrompt: 'persona',
        sandboxKey: 'acme--feat',
        mode: 'execute',
        richStream: true,
        auth: { secret: VALID_CODEX_AUTH },
        onEvent: (e) => events.push(e),
      });

      const toolUse = events.find((e) => e.kind === 'tool_use') as Extract<EngineEvent, { kind: 'tool_use' }>;
      expect(toolUse.input).toEqual({ file_path: 'x.md', kind: 'update' });
      const toolResult = events.find((e) => e.kind === 'tool_result') as Extract<EngineEvent, { kind: 'tool_result' }>;
      expect(toolResult.structuredPatch?.length).toBeGreaterThan(0);
      const lines = toolResult.structuredPatch!.flatMap((h) => h.lines);
      expect(lines).toContain('-line2');
      expect(lines).toContain('+CHANGED');
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe('EngineCore — Codex auth-refresh readback', () => {
  const runCodex = async (opts: {
    refreshedBlob: string | null;
    persistAuthRefresh?: boolean;
    sandboxKey: string;
  }) => {
    const core = new EngineCore(fakeClaudeSdk().sdk, fakeRefreshingCodexSdk(opts.refreshedBlob), {
      homeRoot: HOME_ROOT,
    });
    return core.run({
      engine: 'codex',
      task: 'do it',
      cwd: '/tmp/wt',
      systemPrompt: 'persona',
      sandboxKey: opts.sandboxKey,
      mode: 'execute',
      auth: { secret: VALID_CODEX_AUTH },
      ...(opts.persistAuthRefresh ? { persistAuthRefresh: true } : {}),
    });
  };

  it('relays the refreshed auth.json when Codex rewrote it AND persistAuthRefresh is set', async () => {
    const refreshed = codexAuthBlob('2026-07-02T00:00:00.000Z', 'a2');
    const res = await runCodex({ refreshedBlob: refreshed, persistAuthRefresh: true, sandboxKey: 'rb--hit' });
    expect(res.refreshedAuthSecret).toBe(refreshed);
  });

  it('does NOT relay when the overlay is unchanged (no real refresh)', async () => {
    const res = await runCodex({ refreshedBlob: VALID_CODEX_AUTH, persistAuthRefresh: true, sandboxKey: 'rb--same' });
    expect(res.refreshedAuthSecret).toBeUndefined();
  });

  it('does NOT relay when persistAuthRefresh is unset (env-fallback gate) even though the file changed', async () => {
    const refreshed = codexAuthBlob('2026-07-02T00:00:00.000Z', 'a3');
    const res = await runCodex({ refreshedBlob: refreshed, sandboxKey: 'rb--gated' });
    expect(res.refreshedAuthSecret).toBeUndefined();
  });

  it('does NOT relay a corrupt refreshed overlay (never propagates an invalid blob)', async () => {
    const res = await runCodex({ refreshedBlob: '{not valid json', persistAuthRefresh: true, sandboxKey: 'rb--corrupt' });
    expect(res.refreshedAuthSecret).toBeUndefined();
  });
});

describe('EngineCore — unresumable session detection', () => {
  it('claudeSessionExists is true only when the transcript is present under the config dir', () => {
    const dir = atlasEngineHomeDir(HOME_ROOT, 'claude', 'resume-present');
    expect(claudeSessionExists(dir, 'sess-x')).toBe(false); // no projects dir yet
    mkdirSync(join(dir, 'projects', '-tmp-wt'), { recursive: true });
    writeFileSync(join(dir, 'projects', '-tmp-wt', 'sess-x.jsonl'), '{}');
    expect(claudeSessionExists(dir, 'sess-x')).toBe(true);
    expect(claudeSessionExists(dir, 'sess-other')).toBe(false);
  });

  it('isUnresumableSessionMessage matches the marker', () => {
    expect(isUnresumableSessionMessage(`${UNRESUMABLE_SESSION_MARKER}: nope`)).toBe(true);
    expect(isUnresumableSessionMessage('Claude engine ended: error_during_execution')).toBe(false);
  });

  it('run() throws a marked, specific error (and never calls the SDK) when the session is unresumable', async () => {
    const { sdk, captured } = fakeClaudeSdk();
    const core = new EngineCore(sdk, fakeCodexSdk().sdk, { homeRoot: HOME_ROOT, claudeOauthToken: 'cfg-oauth', codexOauthToken: 'cfg-codex' });
    await expect(
      core.run({
        engine: 'claude',
        task: 'resume me',
        cwd: '/tmp/wt',
        systemPrompt: 'persona',
        sandboxKey: 'resume-missing',
        mode: 'execute',
        auth: { secret: 'oauth-tok' },
        sessionId: 'ghost-session',
      }),
    ).rejects.toThrow(UNRESUMABLE_SESSION_MARKER);
    expect(captured.options).toBeUndefined(); // failed BEFORE querying the SDK
  });

  it('run() resumes normally when the transcript exists', async () => {
    const { sdk, captured } = fakeClaudeSdk();
    const dir = atlasEngineHomeDir(HOME_ROOT, 'claude', 'resume-ok');
    mkdirSync(join(dir, 'projects', '-tmp-wt'), { recursive: true });
    writeFileSync(join(dir, 'projects', '-tmp-wt', 'live-session.jsonl'), '{}');
    const core = new EngineCore(sdk, fakeCodexSdk().sdk, { homeRoot: HOME_ROOT, claudeOauthToken: 'cfg-oauth', codexOauthToken: 'cfg-codex' });
    await core.run({
      engine: 'claude',
      task: 'resume me',
      cwd: '/tmp/wt',
      systemPrompt: 'persona',
      sandboxKey: 'resume-ok',
      mode: 'execute',
      auth: { secret: 'oauth-tok' },
      sessionId: 'live-session',
    });
    expect(captured.options!.resume).toBe('live-session');
  });
});

describe('extractClaudeUsage — per-model breakdown', () => {
  it('preserves the FULL modelUsage map (all models), normalizing SDK field names', () => {
    const usage = extractClaudeUsage(
      {
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 },
        total_cost_usd: 1.5,
        modelUsage: {
          'claude-opus-4-8': {
            inputTokens: 10,
            outputTokens: 15,
            cacheReadInputTokens: 800,
            cacheCreationInputTokens: 50,
            costUSD: 1.2,
          },
          'claude-sonnet-5': {
            inputTokens: 5,
            outputTokens: 5,
            cacheReadInputTokens: 100,
            cacheCreationInputTokens: 0,
            costUSD: 0.3,
            webSearchRequests: 3,
          },
        },
      },
      'claude-opus-4-8',
    );
    expect(usage?.costUsd).toBe(1.5);
    // Both models survive (the old code kept only Object.keys(modelUsage)[0]).
    expect(Object.keys(usage?.modelUsage ?? {})).toEqual(['claude-opus-4-8', 'claude-sonnet-5']);
    expect(usage?.modelUsage?.['claude-sonnet-5']).toEqual({
      inputTokens: 5,
      outputTokens: 5,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      costUsd: 0.3,
      webSearchRequests: 3,
    });
    expect(usage?.modelUsage?.['claude-opus-4-8'].costUsd).toBe(1.2);
  });

  it('omits modelUsage when the SDK reported none', () => {
    const usage = extractClaudeUsage({ usage: { input_tokens: 10, output_tokens: 2 } }, 'claude-opus-4-8');
    expect(usage?.modelUsage).toBeUndefined();
  });
});
