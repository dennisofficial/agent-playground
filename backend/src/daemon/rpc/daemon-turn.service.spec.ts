import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunCommand } from '@harness/workspaces/daemon-protocol';
import {
  DaemonTurnService,
  portForSession,
  SESSION_PORT_BASE,
  SESSION_PORT_SPAN,
} from './daemon-turn.service';

/**
 * Per-session PORT injection (Phase 10 self-validation): each session gets a deterministic, distinct
 * PORT so two dev servers in ONE sandbox don't both grab 3000, injected into the engine run env
 * (process.env, which the engines spread into the subprocess env).
 */

describe('portForSession — deterministic, distinct, in-range', () => {
  it('is deterministic per session id', () => {
    expect(portForSession('sess-abc')).toBe(portForSession('sess-abc'));
  });

  it('lands inside [BASE, BASE+SPAN)', () => {
    for (const id of ['a', 'sess-1', 'session-xyz-42', '']) {
      const p = portForSession(id);
      expect(p).toBeGreaterThanOrEqual(SESSION_PORT_BASE);
      expect(p).toBeLessThan(SESSION_PORT_BASE + SESSION_PORT_SPAN);
    }
  });

  it('distributes distinct ids across distinct ports (low collision over a realistic set)', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `session-${i}`);
    const ports = new Set(ids.map(portForSession));
    // 50 sessions is far more than one sandbox holds; require near-perfect spread (allow a couple of
    // hash collisions in 900 slots without failing the suite).
    expect(ports.size).toBeGreaterThanOrEqual(48);
  });
});

describe('DaemonTurnService.handleRun — PORT injection', () => {
  const prevPort = process.env.PORT;
  const prevRange = process.env.PORT_RANGE_START;
  afterEach(() => {
    if (prevPort === undefined) delete process.env.PORT;
    else process.env.PORT = prevPort;
    if (prevRange === undefined) delete process.env.PORT_RANGE_START;
    else process.env.PORT_RANGE_START = prevRange;
  });

  function makeService(captureEnv: () => void) {
    const engines = {
      get: () => ({
        // The engine snapshots process.env at run time — capture it here.
        run: vi.fn(async () => {
          captureEnv();
          return { result: 'ok', sessionId: 'engine-1' };
        }),
      }),
    } as never;
    const tools = { prime: vi.fn(async () => undefined) } as never;
    const git = {
      whenCloned: vi.fn(async () => undefined),
      worktreePath: () => '/workspace/repo/.workspaces/sess',
      createWorktree: vi.fn(async () => '/workspace/repo/.workspaces/sess'),
    } as never;
    const redis = {
      xadd: vi.fn(async () => '1-0'),
      subscribe: vi.fn(async () => async () => undefined),
    } as never;
    return new DaemonTurnService(engines, tools, git, redis);
  }

  const cmd = (sessionId: string, workAreaId = sessionId): RunCommand => ({
    type: 'run',
    correlationId: 'cid-1',
    payload: {
      engine: 'claude',
      workAreaId,
      sessionId,
      task: 'do it',
      systemPrompt: 'sys',
      agentId: 'agent',
      mode: 'execute',
      skillSources: [],
      mcpServers: [],
    },
  });

  it('sets PORT + PORT_RANGE_START to the session port before the engine runs', async () => {
    let portAtRun: string | undefined;
    let rangeAtRun: string | undefined;
    const svc = makeService(() => {
      portAtRun = process.env.PORT;
      rangeAtRun = process.env.PORT_RANGE_START;
    });
    await svc.handleRun(cmd('sess-port-test'));
    const expected = String(portForSession('sess-port-test'));
    expect(portAtRun).toBe(expected);
    expect(rangeAtRun).toBe(expected);
  });

  it('gives two different sessions two different PORTs', async () => {
    const seen: Record<string, string | undefined> = {};
    let current = '';
    const svc = makeService(() => {
      seen[current] = process.env.PORT;
    });
    current = 'session-A';
    await svc.handleRun(cmd('session-A'));
    current = 'session-B';
    await svc.handleRun(cmd('session-B'));
    expect(seen['session-A']).not.toBe(seen['session-B']);
  });
});
