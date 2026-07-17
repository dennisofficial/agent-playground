import type { AdapterRunArgs, EngineRunResult } from '@workspace/agent-engine';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentMessage } from '../prompt-kit/message';
import { EngineCore } from './engine-core';
import type { EngineHomeKey } from './engine-home';


const HOME_ROOT = join(tmpdir(), `atlas-engine-core-appserver-selector-spec-${process.pid}`);
afterAll(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

const TEST_KEY: EngineHomeKey = {
  orgId: 'acme',
  repoId: 'atlas',
  jobId: 'feat',
  type: 'build',
};

const VALID_CODEX_AUTH = JSON.stringify({
  OPENAI_API_KEY: null,
  tokens: { id_token: 'i', access_token: 'a', refresh_token: 'r' },
  last_refresh: '2026-07-01T00:00:00.000Z',
});

const appServerRunCalls: AdapterRunArgs[] = [];
const appServerResult: EngineRunResult = {
  result: 'appserver done',
  sessionId: 'appserver-thread-1',
  usage: { inputTokens: 7, outputTokens: 2 },
};

vi.mock('@workspace/agent-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspace/agent-engine')>();
  return {
    ...actual,
    CodexAppServerAdapter: class {
      readonly capabilities = new Set([
        'writeGuard',
        'postToolUseContext',
        'midTurnSteer',
        'richStream',
      ]);
      async run(args: AdapterRunArgs): Promise<EngineRunResult> {
        appServerRunCalls.push(args);
        return appServerResult;
      }
    },
  };
});

function fakeLegacyCodexSdk() {
  const threadCalls: Array<Record<string, unknown>> = [];
  class FakeCodex {
    constructor(_opts: Record<string, unknown>) {}
    startThread(opts: Record<string, unknown>) {
      threadCalls.push(opts);
      return {
        id: 'legacy-thread-1',
        runStreamed: async () => ({
          events: (async function* () {
            yield { type: 'thread.started', job_id: 'legacy-thread-1' };
            yield {
              type: 'item.completed',
              item: { type: 'agent_message', text: 'legacy codex done' },
            };
            yield {
              type: 'turn.completed',
              usage: { input_tokens: 4, output_tokens: 1 },
            };
          })(),
        }),
      };
    }
    resumeThread(_id: string, opts: Record<string, unknown>) {
      return this.startThread(opts);
    }
  }
  return {
    sdk: { Codex: FakeCodex } as unknown as typeof import('@openai/codex-sdk'),
    threadCalls,
  };
}

function fakeClaudeSdk() {
  return {} as unknown as typeof import('@anthropic-ai/claude-agent-sdk');
}

beforeEach(() => {
  appServerRunCalls.length = 0;
});
afterEach(() => {
  delete process.env.CODEX_APPSERVER_ENABLED;
});

describe('EngineCore — CODEX_APPSERVER_ENABLED adapter selector', () => {
  it('flag unset (default OFF): a Codex run() routes through legacy runCodex, never the app-server adapter; usage.appserver stamps false', async () => {
    const { sdk, threadCalls } = fakeLegacyCodexSdk();
    const core = new EngineCore(fakeClaudeSdk(), sdk, { homeRoot: HOME_ROOT });
    const res = await core.run({
      engine: 'codex',
      task: agentMessage('do it'),
      cwd: '/tmp/wt',
      systemPrompt: agentMessage('persona'),
      sandboxKey: TEST_KEY,
      mode: 'execute',
      auth: { secret: VALID_CODEX_AUTH },
    });
    expect(threadCalls).toHaveLength(1);
    expect(appServerRunCalls).toHaveLength(0);
    expect(res.result).toBe('legacy codex done');
    expect(res.usage).toMatchObject({ appserver: false });
  });

  it("flag ON ('true'): a Codex run() routes through CodexAppServerAdapter with resolved auth; usage.appserver stamps true", async () => {
    process.env.CODEX_APPSERVER_ENABLED = 'true';
    const { sdk, threadCalls } = fakeLegacyCodexSdk();
    const core = new EngineCore(fakeClaudeSdk(), sdk, { homeRoot: HOME_ROOT });
    const res = await core.run({
      engine: 'codex',
      task: agentMessage('do it'),
      cwd: '/tmp/wt',
      systemPrompt: agentMessage('persona'),
      sandboxKey: TEST_KEY,
      mode: 'execute',
      auth: { secret: VALID_CODEX_AUTH },
    });
    expect(threadCalls).toHaveLength(0);
    expect(appServerRunCalls).toHaveLength(1);
    expect(appServerRunCalls[0].auth?.secret).toBe(VALID_CODEX_AUTH);
    expect(appServerRunCalls[0].sandboxKey).toEqual(TEST_KEY);
    expect(res.result).toBe('appserver done');
    expect(res.usage).toMatchObject({ appserver: true });
  });

  it("flag ON ('1', the alternate truthy spelling) also selects the app-server adapter", async () => {
    process.env.CODEX_APPSERVER_ENABLED = '1';
    const { sdk } = fakeLegacyCodexSdk();
    const core = new EngineCore(fakeClaudeSdk(), sdk, { homeRoot: HOME_ROOT });
    await core.run({
      engine: 'codex',
      task: agentMessage('do it'),
      cwd: '/tmp/wt',
      systemPrompt: agentMessage('persona'),
      sandboxKey: TEST_KEY,
      mode: 'execute',
      auth: { secret: VALID_CODEX_AUTH },
    });
    expect(appServerRunCalls).toHaveLength(1);
  });

  it('a Claude run() is unaffected by the flag even when ON', async () => {
    process.env.CODEX_APPSERVER_ENABLED = 'true';
    const { sdk } = fakeLegacyCodexSdk();
    const core = new EngineCore(fakeClaudeSdk(), sdk, { homeRoot: HOME_ROOT });
    await expect(
      core.run({
        engine: 'claude',
        task: agentMessage('do it'),
        cwd: '/tmp/wt',
        systemPrompt: agentMessage('persona'),
        sandboxKey: TEST_KEY,
        mode: 'execute',
        auth: { secret: 'sk-test' },
      }),
    ).rejects.toBeDefined(); // fakeClaudeSdk() has no `query` — proves this path never touches CodexAppServerAdapter.
    expect(appServerRunCalls).toHaveLength(0);
  });

  it('runWithExtras: non-empty codexBridgeTools falls back to legacy runCodex even with the flag ON (CodexAppServerAdapter has no bridge wiring in thread 2)', async () => {
    process.env.CODEX_APPSERVER_ENABLED = 'true';
    const { sdk, threadCalls } = fakeLegacyCodexSdk();
    const core = new EngineCore(fakeClaudeSdk(), sdk, { homeRoot: HOME_ROOT });
    const res = await core.runWithExtras(
      {
        engine: 'codex',
        task: agentMessage('do it'),
        cwd: '/tmp/wt',
        systemPrompt: agentMessage('persona'),
        sandboxKey: TEST_KEY,
        mode: 'execute',
        auth: { secret: VALID_CODEX_AUTH },
      },
      undefined,
      undefined,
      ['some_host_tool'],
      undefined,
    );
    expect(threadCalls).toHaveLength(1);
    expect(appServerRunCalls).toHaveLength(0);
    expect(res.result).toBe('legacy codex done');
  });

  it('runWithExtras: no bridge extras + flag ON routes through CodexAppServerAdapter', async () => {
    process.env.CODEX_APPSERVER_ENABLED = 'true';
    const { sdk } = fakeLegacyCodexSdk();
    const core = new EngineCore(fakeClaudeSdk(), sdk, { homeRoot: HOME_ROOT });
    const res = await core.runWithExtras(
      {
        engine: 'codex',
        task: agentMessage('do it'),
        cwd: '/tmp/wt',
        systemPrompt: agentMessage('persona'),
        sandboxKey: TEST_KEY,
        mode: 'execute',
        auth: { secret: VALID_CODEX_AUTH },
      },
      undefined,
      undefined,
      [],
      {},
    );
    expect(appServerRunCalls).toHaveLength(1);
    expect(res.result).toBe('appserver done');
  });
});
