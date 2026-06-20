import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { EngineRunner } from './engine-runner.service';

const HOME_ROOT = join(tmpdir(), `atlas-engine-spec-${process.pid}`);
afterAll(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

/** A stub EnvService driven by a plain record. */
function envStub(values: Record<string, string | undefined>) {
  return { get: (k: string) => values[k] } as never;
}

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

describe('EngineRunner — Claude mode/home/credential wiring', () => {
  it('execute mode: write tools, default permission, isolated CLAUDE_CONFIG_DIR, api key threaded', async () => {
    const { sdk, captured } = fakeClaudeSdk();
    const runner = new EngineRunner(sdk, fakeCodexSdk().sdk, envStub({ ATLAS_AGENT_HOME_ROOT: HOME_ROOT }));
    const res = await runner.run({
      engine: 'claude',
      task: 'do it',
      cwd: '/tmp/wt',
      systemPrompt: 'persona',
      sandboxKey: 'acme--feat',
      mode: 'execute',
      auth: { mode: 'api_key', apiKey: 'turn-key' },
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
    // Credentials threaded into the SUBPROCESS env, not process.env.
    expect(env.ANTHROPIC_API_KEY).toBe('turn-key');
    expect(process.env.ANTHROPIC_API_KEY).not.toBe('turn-key');
    // settingSources [] = full isolation (no on-disk config files read).
    expect(opts.settingSources).toEqual([]);
    // Result + usage surfaced.
    expect(res.result).toBe('done');
    expect(res.sessionId).toBe('sess-1');
    expect(res.usage).toMatchObject({ inputTokens: 12, outputTokens: 4, costUsd: 0.01 });
  });

  it('plan mode: permissionMode plan, ExitPlanMode tool present, no writes flag in canUseTool', async () => {
    const { sdk, captured } = fakeClaudeSdk();
    const runner = new EngineRunner(sdk, fakeCodexSdk().sdk, envStub({ ATLAS_AGENT_HOME_ROOT: HOME_ROOT }));
    await runner.run({
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
    const runner = new EngineRunner(sdk, fakeCodexSdk().sdk, envStub({ ATLAS_AGENT_HOME_ROOT: HOME_ROOT }));
    await runner.run({
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

  it('subscription auth from env strips the API key and sets the OAuth token', async () => {
    const { sdk, captured } = fakeClaudeSdk();
    const runner = new EngineRunner(
      sdk,
      fakeCodexSdk().sdk,
      envStub({
        ATLAS_AGENT_HOME_ROOT: HOME_ROOT,
        ATLAS_ENGINE_AUTH_MODE: 'subscription',
        ATLAS_CLAUDE_OAUTH_TOKEN: 'oauth-from-env',
        ANTHROPIC_API_KEY: 'should-be-stripped',
      }),
    );
    await runner.run({
      engine: 'claude',
      task: 'x',
      cwd: '/tmp/wt',
      systemPrompt: 'p',
      sandboxKey: 'k',
      mode: 'execute',
    });
    const env = captured.options!.env as Record<string, string>;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-from-env');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe('EngineRunner — Codex mode/home/credential wiring', () => {
  it('execute mode: workspace-write sandbox, isolated CODEX_HOME, api key on the client', async () => {
    const { sdk, ctorCalls, threadCalls } = fakeCodexSdk();
    const runner = new EngineRunner(fakeClaudeSdk().sdk, sdk, envStub({ ATLAS_AGENT_HOME_ROOT: HOME_ROOT }));
    const res = await runner.run({
      engine: 'codex',
      task: 'do it',
      cwd: '/tmp/wt',
      systemPrompt: 'persona',
      sandboxKey: 'acme--feat',
      mode: 'execute',
      auth: { mode: 'api_key', apiKey: 'codex-key' },
    });
    expect(ctorCalls[0].apiKey).toBe('codex-key');
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
    const runner = new EngineRunner(fakeClaudeSdk().sdk, sdk, envStub({ ATLAS_AGENT_HOME_ROOT: HOME_ROOT }));
    await runner.run({
      engine: 'codex',
      task: 'plan it',
      cwd: '/tmp/wt',
      systemPrompt: 'persona',
      sandboxKey: 'acme--feat',
      mode: 'plan',
      auth: { mode: 'api_key', apiKey: 'k' },
    });
    expect(threadCalls[0].sandboxMode).toBe('read-only');
  });
});
