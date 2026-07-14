import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterRunArgs, EngineCapability, EngineRunResult } from '@workspace/agent-engine';
import { agentMessage } from '../prompt-kit/message';
import type { EngineHomeKey } from './engine-home';
import { EngineCore } from './engine-core';

/**
 * Exercises `EngineCore.buildCodexHooks` — the EngineLocalHooks assembled for the `codex app-server` path
 * from the JIT rule catalog (svc-nudge + leg-rotation) plus the structural write-guard, then filtered through
 * `guardHooksAgainstCapabilities`. Like `engine-core.codex-appserver-selector.spec.ts`, `CodexAppServerAdapter`
 * is replaced with a capturing fake — a unit test must never spawn the real `codex app-server` subprocess.
 */

const HOME_ROOT = join(tmpdir(), `atlas-engine-core-codex-hooks-spec-${process.pid}`);
afterAll(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

const TEST_KEY: EngineHomeKey = { orgId: 'acme', repoId: 'atlas', jobId: 'feat', type: 'build' };

const VALID_CODEX_AUTH = JSON.stringify({
  OPENAI_API_KEY: null,
  tokens: { id_token: 'i', access_token: 'a', refresh_token: 'r' },
  last_refresh: '2026-07-01T00:00:00.000Z',
});

// Controlled per-test so the capability-degradation case can drop `writeGuard`/`midTurnSteer` without a
// second `vi.mock` factory (factories are hoisted and evaluated once per file).
let fakeCapabilities: ReadonlySet<EngineCapability> = new Set([
  'writeGuard',
  'postToolUseContext',
  'midTurnSteer',
  'richStream',
]);

const appServerRunCalls: AdapterRunArgs[] = [];
const appServerResult: EngineRunResult = { result: 'appserver done', sessionId: 'appserver-thread-1' };

vi.mock('@workspace/agent-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspace/agent-engine')>();
  return {
    ...actual,
    CodexAppServerAdapter: class {
      get capabilities(): ReadonlySet<EngineCapability> {
        return fakeCapabilities;
      }
      async run(args: AdapterRunArgs): Promise<EngineRunResult> {
        appServerRunCalls.push(args);
        return appServerResult;
      }
    },
  };
});

function fakeCodexSdk() {
  class FakeCodex {
    constructor(_opts: Record<string, unknown>) {}
  }
  return { Codex: FakeCodex } as unknown as typeof import('@openai/codex-sdk');
}

function fakeClaudeSdk() {
  return {} as unknown as typeof import('@anthropic-ai/claude-agent-sdk');
}

async function runCodexAppServerTurn(core: EngineCore, mode: 'plan' | 'execute' | 'review') {
  process.env.CODEX_APPSERVER_ENABLED = 'true';
  await core.run({
    engine: 'codex',
    task: agentMessage('do it'),
    cwd: '/tmp/wt',
    systemPrompt: agentMessage('persona'),
    sandboxKey: TEST_KEY,
    mode,
    auth: { secret: VALID_CODEX_AUTH },
  });
}

beforeEach(() => {
  appServerRunCalls.length = 0;
  fakeCapabilities = new Set(['writeGuard', 'postToolUseContext', 'midTurnSteer', 'richStream']);
});
afterEach(() => {
  delete process.env.CODEX_APPSERVER_ENABLED;
});

describe('EngineCore — Codex-app-server EngineLocalHooks wiring', () => {
  it('write-guard denies a fileChange approval on a read-only (plan-mode) turn', async () => {
    const core = new EngineCore(fakeClaudeSdk(), fakeCodexSdk(), { homeRoot: HOME_ROOT });
    await runCodexAppServerTurn(core, 'plan');

    const hooks = appServerRunCalls[0].hooks;
    const verdict = hooks?.writeGuard?.('fileChange', { path: '/tmp/wt/foo.ts' });
    expect(verdict).toEqual({ allow: false, reason: 'This is a read-only turn — no file writes.' });
  });

  it("write-guard denies a fileChange approval on plan_review's real mode:'review' turn", async () => {
    const core = new EngineCore(fakeClaudeSdk(), fakeCodexSdk(), { homeRoot: HOME_ROOT });
    await runCodexAppServerTurn(core, 'review');

    const hooks = appServerRunCalls[0].hooks;
    const verdict = hooks?.writeGuard?.('fileChange', { path: '/tmp/wt/foo.ts' });
    expect(verdict).toEqual({ allow: false, reason: 'This is a read-only turn — no file writes.' });
  });

  it('write-guard denies a fileChange approval outside the writable roots on an execute turn', async () => {
    const core = new EngineCore(fakeClaudeSdk(), fakeCodexSdk(), { homeRoot: HOME_ROOT });
    await runCodexAppServerTurn(core, 'execute');

    const hooks = appServerRunCalls[0].hooks;
    const verdict = hooks?.writeGuard?.('fileChange', { path: '/etc/passwd' });
    expect(verdict?.allow).toBe(false);
    expect(verdict?.reason).toContain('Write outside the allowed roots');
    expect(verdict?.reason).toContain('/etc/passwd');
  });

  it('write-guard allows a fileChange approval inside cwd on an execute turn', async () => {
    const core = new EngineCore(fakeClaudeSdk(), fakeCodexSdk(), { homeRoot: HOME_ROOT });
    await runCodexAppServerTurn(core, 'execute');

    const hooks = appServerRunCalls[0].hooks;
    const verdict = hooks?.writeGuard?.('fileChange', { path: '/tmp/wt/foo.ts' });
    expect(verdict).toEqual({ allow: true });
  });

  it('rotation hooks carry the leg-rotation catalog thresholds and rendered soft/reminder text', async () => {
    const core = new EngineCore(fakeClaudeSdk(), fakeCodexSdk(), { homeRoot: HOME_ROOT });
    await runCodexAppServerTurn(core, 'execute');

    const rotation = appServerRunCalls[0].hooks?.rotation;
    expect(rotation).toBeDefined();
    expect(rotation?.softTokens).toBe(150_000);
    expect(rotation?.reminderDeltaTokens).toBe(25_000);
    expect(typeof rotation?.softText).toBe('string');
    expect(typeof rotation?.reminderText).toBe('string');
    expect(rotation?.softText).not.toBe(rotation?.reminderText);
  });

  it('postToolUseContext fires the svc-nudge text for a long-running Bash command, and stays silent otherwise', async () => {
    const core = new EngineCore(fakeClaudeSdk(), fakeCodexSdk(), { homeRoot: HOME_ROOT });
    await runCodexAppServerTurn(core, 'execute');

    const postToolUseContext = appServerRunCalls[0].hooks?.postToolUseContext;
    expect(postToolUseContext).toBeDefined();
    expect(postToolUseContext?.('Bash', { command: 'pnpm dev' }, 1_000)).toEqual(expect.any(String));
    expect(postToolUseContext?.('Bash', { command: 'pnpm test' }, 1_000)).toBeNull();
  });

  it('capability guard drops writeGuard/rotation when the adapter does not declare writeGuard/midTurnSteer', async () => {
    fakeCapabilities = new Set(['postToolUseContext', 'richStream']);
    const core = new EngineCore(fakeClaudeSdk(), fakeCodexSdk(), { homeRoot: HOME_ROOT });
    await runCodexAppServerTurn(core, 'execute');

    const hooks = appServerRunCalls[0].hooks;
    expect(hooks?.writeGuard).toBeUndefined();
    expect(hooks?.rotation).toBeUndefined();
    expect(hooks?.postToolUseContext).toBeDefined();
  });
});
