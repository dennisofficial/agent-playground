import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeSessionExists, EngineCore } from './engine-core';
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
            yield { type: 'thread.started', thread_id: 'thread-1' };
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

  it('writer subagents (implement/implement-fast) are spawnable ONLY on execute turns, not plan/review', async () => {
    const run = async (mode: 'execute' | 'plan' | 'review') => {
      const { sdk, captured } = fakeClaudeSdk();
      const core = new EngineCore(sdk, fakeCodexSdk().sdk, { homeRoot: HOME_ROOT, claudeOauthToken: 'o', codexOauthToken: 'c' });
      await core.run({ engine: 'claude', task: 't', cwd: '/tmp/wt', systemPrompt: 'p', sandboxKey: 'a--b', mode, auth: { secret: 'tok' } });
      return captured.options!.agents as Record<string, { tools: string[]; model: string }>;
    };

    const execAgents = await run('execute');
    // Writers present, Opus/Sonnet, can Write/Edit/Bash, and have NO Task (no recursive fan-out).
    expect(execAgents.implement).toBeDefined();
    expect(execAgents['implement-fast']).toBeDefined();
    expect(execAgents.implement.model).toBe('opus');
    expect(execAgents['implement-fast'].model).toBe('sonnet');
    for (const w of [execAgents.implement, execAgents['implement-fast']]) {
      expect(w.tools).toEqual(expect.arrayContaining(['Write', 'Edit', 'Bash']));
      expect(w.tools).not.toContain('Task');
    }
    // The advisory read-only subagent is still there.
    expect(execAgents.explore).toBeDefined();

    // Plan + review turns get ONLY the advisory set — no writers can be spawned.
    for (const mode of ['plan', 'review'] as const) {
      const agents = await run(mode);
      expect(agents.explore).toBeDefined();
      expect(agents.implement).toBeUndefined();
      expect(agents['implement-fast']).toBeUndefined();
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
    // Auto-approve: safe reads + web + subagent spawning. Writes/Bash still fall through to canUseTool.
    expect(opts.allowedTools).toEqual(['Read', 'Glob', 'Grep', 'Task', 'WebSearch', 'WebFetch']);
    expect(opts.mcpServers).toBeUndefined();
  });
});

describe('EngineCore — Codex mode/home/credential wiring', () => {
  it('execute mode: workspace-write sandbox, subscription auth.json home, NO apiKey on the client', async () => {
    const { sdk, ctorCalls, threadCalls } = fakeCodexSdk();
    const core = new EngineCore(fakeClaudeSdk().sdk, sdk, { homeRoot: HOME_ROOT, claudeOauthToken: 'cfg-oauth', codexOauthToken: 'cfg-codex' });
    const res = await core.run({
      engine: 'codex',
      task: 'do it',
      cwd: '/tmp/wt',
      systemPrompt: 'persona',
      sandboxKey: 'acme--feat',
      mode: 'execute',
      auth: { secret: 'codex-oauth' },
    });
    // Subscription-only: the CLI reads auth.json from CODEX_HOME, so NO apiKey is passed to the client.
    expect(ctorCalls[0].apiKey).toBeUndefined();
    const ctorEnv = ctorCalls[0].env as Record<string, string>;
    expect(ctorEnv.CODEX_HOME).toContain(HOME_ROOT);
    expect(ctorEnv.CODEX_HOME).not.toContain('/.codex/');
    expect(threadCalls[0].sandboxMode).toBe('workspace-write');
    expect(res.result).toBe('codex done');
    expect(res.sessionId).toBe('thread-1');
    expect(res.usage).toMatchObject({ inputTokens: 5, outputTokens: 3 });
  });

  it('plan mode: read-only sandbox', async () => {
    const { sdk, threadCalls } = fakeCodexSdk();
    const core = new EngineCore(fakeClaudeSdk().sdk, sdk, { homeRoot: HOME_ROOT, claudeOauthToken: 'cfg-oauth', codexOauthToken: 'cfg-codex' });
    await core.run({
      engine: 'codex',
      task: 'plan it',
      cwd: '/tmp/wt',
      systemPrompt: 'persona',
      sandboxKey: 'acme--feat',
      mode: 'plan',
      auth: { secret: 'codex-oauth' },
    });
    expect(threadCalls[0].sandboxMode).toBe('read-only');
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
