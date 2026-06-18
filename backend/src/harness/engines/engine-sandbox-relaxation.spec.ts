import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvService } from '@core/config/env/env.service';
import type { RunWorkerArgs } from './worker-engine.port';

/**
 * In-sandbox self-validation relaxation (Phase 10) — proves the env-gated execute-turn relaxation,
 * AND that the HOST (flag unset) path is byte-identical to before.
 *
 * The relaxed posture is read from `SANDBOX_GUARD_RELAXED` at GUARD MODULE LOAD, so each block
 * re-imports the engine under a fresh `process.env` via `vi.resetModules()`:
 *  - Claude: relaxed → the SDK is given `spawnClaudeCodeProcess` (own process-group spawn → reaping);
 *            host → the option is ABSENT (the SDK's own spawn runs unchanged).
 *  - Codex:  relaxed + EXECUTE → `networkAccessEnabled: true` on the workspace-write sandbox (so
 *            pnpm install / curl work); host, OR read-only even when relaxed → the option is ABSENT.
 */

const envStub = {
  get: (k: string) => (k === 'AGENT_HOME_ROOT' ? '/tmp/homes' : undefined),
} as unknown as EnvService;

const baseArgs = (mode: 'plan' | 'execute' | 'investigate'): RunWorkerArgs => ({
  task: 'do the thing',
  cwd: '/tmp/wt',
  systemPrompt: 'worker prompt',
  agentId: 'test-agent',
  mode,
  onEvent: () => {},
});

// ── Claude ─────────────────────────────────────────────────────────────────────────────────────

interface ClaudeCaptured {
  spawnClaudeCodeProcess?: unknown;
}

function stubClaudeSdk(captured: ClaudeCaptured) {
  return {
    query({ options }: { prompt: string; options: ClaudeCaptured }) {
      captured.spawnClaudeCodeProcess = options.spawnClaudeCodeProcess;
      return (async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'engine-1',
        };
      })();
    },
  };
}

async function runClaude(
  relaxed: boolean,
  mode: 'plan' | 'execute' = 'execute',
): Promise<ClaudeCaptured> {
  vi.resetModules();
  if (relaxed) process.env.SANDBOX_GUARD_RELAXED = 'true';
  else delete process.env.SANDBOX_GUARD_RELAXED;
  const { ClaudeEngine } = await import('./claude.engine.js');
  const captured: ClaudeCaptured = {};
  const provisioner = {
    forAgent: () => ({ skillNames: [], mcpServers: [] }),
  } as never;
  const engine = new ClaudeEngine(stubClaudeSdk(captured) as never, envStub, provisioner);
  await engine.run(baseArgs(mode));
  return captured;
}

describe('ClaudeEngine — relaxed-sandbox process-group spawn', () => {
  const prev = process.env.SANDBOX_GUARD_RELAXED;
  afterEach(() => {
    if (prev === undefined) delete process.env.SANDBOX_GUARD_RELAXED;
    else process.env.SANDBOX_GUARD_RELAXED = prev;
    vi.resetModules();
  });

  it('relaxed → passes a spawnClaudeCodeProcess hook (own process group → reaping)', async () => {
    const captured = await runClaude(true, 'execute');
    expect(typeof captured.spawnClaudeCodeProcess).toBe('function');
  });

  it('HOST (flag unset) → NO spawn hook (SDK spawn unchanged, byte-identical)', async () => {
    const captured = await runClaude(false, 'execute');
    expect(captured.spawnClaudeCodeProcess).toBeUndefined();
  });
});

// ── Codex ──────────────────────────────────────────────────────────────────────────────────────

interface ThreadOptsCaptured {
  sandboxMode?: string;
  networkAccessEnabled?: boolean;
}

function stubCodexSdk(captured: { opts?: ThreadOptsCaptured }) {
  const thread = {
    id: 'thread-1',
    runStreamed() {
      const gen = async function* () {
        yield { type: 'thread.started', thread_id: 'thread-1' };
        yield {
          type: 'item.completed',
          item: { type: 'agent_message', text: 'Done.' },
        };
      };
      return { events: gen() };
    },
  };
  const client = {
    startThread: (opts: ThreadOptsCaptured) => {
      captured.opts = opts;
      return thread;
    },
    resumeThread: (_id: string, opts: ThreadOptsCaptured) => {
      captured.opts = opts;
      return thread;
    },
  };
  return {
    Codex: class {
      constructor() {
        Object.assign(this, client);
      }
    },
  } as unknown as typeof import('@openai/codex-sdk');
}

async function runCodex(
  relaxed: boolean,
  mode: 'plan' | 'execute' | 'investigate',
): Promise<ThreadOptsCaptured> {
  vi.resetModules();
  if (relaxed) process.env.SANDBOX_GUARD_RELAXED = 'true';
  else delete process.env.SANDBOX_GUARD_RELAXED;
  const { CodexEngine } = await import('./codex.engine.js');
  const captured: { opts?: ThreadOptsCaptured } = {};
  const provisioner = {
    forAgent: () => ({ skillNames: [], skillsPrompt: '', mcpServers: [] }),
  } as never;
  const engine = new CodexEngine(stubCodexSdk(captured) as never, envStub, provisioner);
  await engine.run(baseArgs(mode));
  return captured.opts ?? {};
}

describe('CodexEngine — relaxed-sandbox network access', () => {
  const prev = process.env.SANDBOX_GUARD_RELAXED;
  afterEach(() => {
    if (prev === undefined) delete process.env.SANDBOX_GUARD_RELAXED;
    else process.env.SANDBOX_GUARD_RELAXED = prev;
    vi.resetModules();
  });

  it('relaxed + EXECUTE → workspace-write WITH network access (pnpm install / curl work)', async () => {
    const opts = await runCodex(true, 'execute');
    expect(opts.sandboxMode).toBe('workspace-write');
    expect(opts.networkAccessEnabled).toBe(true);
  });

  it('relaxed + READ-ONLY (plan) → read-only sandbox, NO network (stays locked down)', async () => {
    const opts = await runCodex(true, 'plan');
    expect(opts.sandboxMode).toBe('read-only');
    expect(opts.networkAccessEnabled).toBeUndefined();
  });

  it('HOST (flag unset) + EXECUTE → workspace-write, NO network grant (byte-identical)', async () => {
    const opts = await runCodex(false, 'execute');
    expect(opts.sandboxMode).toBe('workspace-write');
    expect(opts.networkAccessEnabled).toBeUndefined();
  });
});
