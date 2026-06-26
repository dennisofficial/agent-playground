import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { EngineCore } from './engine-core';
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

  it('no bridge: allowedTools stays the read set and no mcpServers leak (worker invariant)', async () => {
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
    expect(opts.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
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
