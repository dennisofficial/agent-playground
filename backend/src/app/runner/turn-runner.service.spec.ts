import { describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import { EngineAuthError, type EngineRunnerPort, type RunEngineArgs } from '../engine';
import type { StepEntity } from '../persistence/entities';
import type { FeatureSandbox } from '../git';
import { TurnRunnerService } from './turn-runner.service';
import { agentMessage } from '../prompt-kit/message';

/**
 * TurnRunnerService — DURABILITY of the resume handle. The point: a coding session must survive a halt
 * by CONTINUING, not respawning. That hinges on the engine `session_id` being persisted onto the step
 * row the instant it exists (turn START), so a mid-turn crash/kill/restart still has a resume handle.
 */

/** A fake steps repo capturing the last persisted session_id; `findOne` returns the prior one. */
function fakeSteps(priorSessionId: string | null = null) {
  const updates: Array<{ id: unknown; patch: { session_id?: string } }> = [];
  let current = priorSessionId;
  const repo = {
    findOne: vi.fn(async () => (current === null ? null : ({ session_id: current } as StepEntity))),
    update: vi.fn(async (where: { id: unknown }, patch: { session_id?: string }) => {
      updates.push({ id: where.id, patch });
      if (patch.session_id) current = patch.session_id;
      return { affected: 1 } as never;
    }),
  } as unknown as Repository<StepEntity>;
  return { repo, updates, last: () => current };
}

const sandbox: FeatureSandbox = {
  repoId: 'proj',
  branch: 'atlas/feat',
  worktreePath: '/wt/feat',
  gitUrl: 'https://github.com/acme/widget',
};

const baseInput = {
  orgId: 'org-1',
  jobId: 'job-1',
  stepId: 'step-1',
  sandbox,
  engine: 'claude' as const,
  mode: 'execute' as const,
  task: agentMessage('do it'),
  systemPrompt: agentMessage('persona'),
};

describe('TurnRunnerService — session-handle durability', () => {
  it('persists the session id on the early `session` event, BEFORE the turn finishes', async () => {
    const { repo, last } = fakeSteps();
    // An engine that surfaces the session at turn start, then keeps "working" — assert the handle is
    // already persisted by the time work begins (we observe right after the session event fires).
    const engine: EngineRunnerPort = {
      run: vi.fn(async (args: RunEngineArgs) => {
        args.onEvent?.({ kind: 'session', sessionId: 'sess-early' });
        // by now the runner should have persisted it
        expect(last()).toBe('sess-early');
        args.onEvent?.({ kind: 'tool', name: 'Write' });
        return { result: 'done', sessionId: 'sess-early' };
      }),
    };
    const runner = new TurnRunnerService(engine, repo);
    const res = await runner.runTurn(baseInput);
    expect(res.report).toBe('done');
    expect(last()).toBe('sess-early');
  });

  it('keeps the session id even when the turn HALTS mid-flight (continues, not respawns)', async () => {
    const { repo, last, updates } = fakeSteps();
    // The session is established, then the turn dies (process crash / kill / non-auth error).
    const engine: EngineRunnerPort = {
      run: vi.fn(async (args: RunEngineArgs) => {
        args.onEvent?.({ kind: 'session', sessionId: 'sess-mid' });
        throw new Error('engine process died mid-turn');
      }),
    };
    const runner = new TurnRunnerService(engine, repo);
    await expect(runner.runTurn(baseInput)).rejects.toThrow(/died mid-turn/);
    // The resume handle survived the halt — a re-run will CONTINUE this session, not spawn a fresh one.
    expect(last()).toBe('sess-mid');
    expect(updates.some((u) => u.patch.session_id === 'sess-mid')).toBe(true);
  });

  it('on a 401 the auth-error session id is persisted too (resume after credential fix)', async () => {
    const { repo, last } = fakeSteps();
    const engine: EngineRunnerPort = {
      run: vi.fn(async () => {
        throw new EngineAuthError('401 invalid api key', 'sess-401');
      }),
    };
    const runner = new TurnRunnerService(engine, repo);
    await expect(runner.runTurn(baseInput)).rejects.toBeInstanceOf(EngineAuthError);
    expect(last()).toBe('sess-401');
  });

  it('resumes a prior session: the persisted id is threaded back as `sessionId`', async () => {
    const { repo } = fakeSteps('sess-prior');
    let seen: string | undefined;
    const engine: EngineRunnerPort = {
      run: vi.fn(async (args: RunEngineArgs) => {
        seen = args.sessionId;
        return { result: 'continued', sessionId: args.sessionId };
      }),
    };
    const runner = new TurnRunnerService(engine, repo);
    await runner.runTurn(baseInput);
    expect(seen).toBe('sess-prior'); // continues the SAME session, not a new one
  });

  // ── Leg-rotation clear-on-birth: a rotated step starts fresh, and the birth write clears its markers ──

  /** A steps repo pre-seeded with a PENDING rotation (session NULLed, seed + abandon marker still set). */
  function fakeRotatedSteps(rotatingSessionId: string) {
    const updates: Array<{ id: unknown; patch: Record<string, unknown> }> = [];
    const repo = {
      findOne: vi.fn(
        async () =>
          ({
            session_id: null, // driver NULLed it on rotation → we start fresh
            rotating_session_id: rotatingSessionId,
            pending_leg_seed: 'ROTATION SEED',
          }) as unknown as StepEntity,
      ),
      update: vi.fn(async (where: { id: unknown }, patch: Record<string, unknown>) => {
        updates.push({ id: where.id, patch });
        return { affected: 1 } as never;
      }),
    } as unknown as Repository<StepEntity>;
    return { repo, updates };
  }

  it('clears the Leg-rotation markers atomically when a FRESH rotated session is born', async () => {
    const { repo, updates } = fakeRotatedSteps('sess-fat');
    const engine: EngineRunnerPort = {
      run: vi.fn(async (args: RunEngineArgs) => {
        args.onEvent?.({ kind: 'session', sessionId: 'sess-fresh' });
        return { result: 'continued', sessionId: 'sess-fresh' };
      }),
    };
    await new TurnRunnerService(engine, repo).runTurn(baseInput);
    // The birth write nulls the seed + abandon marker in the SAME update as the new session id.
    const birth = updates.find((u) => u.patch.session_id === 'sess-fresh');
    expect(birth?.patch).toMatchObject({
      session_id: 'sess-fresh',
      pending_leg_seed: null,
      rotating_session_id: null,
    });
  });

  it('does NOT clear the markers if the born session equals the one being abandoned (defensive guard)', async () => {
    const { repo, updates } = fakeRotatedSteps('sess-fat');
    const engine: EngineRunnerPort = {
      run: vi.fn(async (args: RunEngineArgs) => {
        // Pathological: the engine re-surfaces the abandoned session id — must NOT be treated as a fresh birth.
        args.onEvent?.({ kind: 'session', sessionId: 'sess-fat' });
        return { result: 'x', sessionId: 'sess-fat' };
      }),
    };
    await new TurnRunnerService(engine, repo).runTurn(baseInput);
    expect(updates.every((u) => !('pending_leg_seed' in u.patch))).toBe(true);
  });
});

describe('TurnRunnerService — git auth threading', () => {
  // A row-sourced sandbox: it has a container, but an EMPTY gitUrl / no token (auth is resolved lazily,
  // per JobLifecycleService.rowToSandbox). So any authenticated git MUST come from `input.gitAuth`.
  const rowSourced: FeatureSandbox = {
    repoId: 'proj',
    branch: 'atlas/feat',
    worktreePath: '/wt/feat',
    gitUrl: '',
    containerId: 'ctr-1',
    execUser: '1000:1000',
  };

  it('puts input.gitAuth onto the docker target (sourced from the resolved repo, not the empty sandbox)', async () => {
    const { repo } = fakeSteps();
    const received: RunEngineArgs[] = [];
    const engine: EngineRunnerPort = {
      run: vi.fn(async (args: RunEngineArgs) => {
        received.push(args);
        return { result: 'ok' };
      }),
    };
    await new TurnRunnerService(engine, repo).runTurn({
      ...baseInput,
      sandbox: rowSourced,
      gitAuth: { gitUrl: 'https://github.com/o/r.git', token: 'tok' },
    });

    expect(received[0].target?.gitAuth).toEqual({
      gitUrl: 'https://github.com/o/r.git',
      token: 'tok',
    });
    // Container identity still comes from the sandbox; only the auth is sourced from the resolved repo.
    expect(received[0].target?.containerId).toBe('ctr-1');
  });

  it('omits gitAuth on the target when the turn passes none (analysis turns stay unauthenticated)', async () => {
    const { repo } = fakeSteps();
    const received: RunEngineArgs[] = [];
    const engine: EngineRunnerPort = {
      run: vi.fn(async (args: RunEngineArgs) => {
        received.push(args);
        return { result: 'ok' };
      }),
    };
    await new TurnRunnerService(engine, repo).runTurn({ ...baseInput, sandbox: rowSourced });

    expect(received[0].target?.gitAuth).toBeUndefined();
  });
});

describe('TurnRunnerService — evidence dir threading', () => {
  // Same row-sourced sandbox as the git-auth block: a `target` only appears when `sandbox.containerId`
  // is set, so these need a container-backed sandbox to exercise the evidenceDir spread at all.
  const rowSourced: FeatureSandbox = {
    repoId: 'proj',
    branch: 'atlas/feat',
    worktreePath: '/wt/feat',
    gitUrl: '',
    containerId: 'ctr-1',
    execUser: '1000:1000',
  };

  it('puts input.evidenceDir onto the docker target', async () => {
    const { repo } = fakeSteps();
    const received: RunEngineArgs[] = [];
    const engine: EngineRunnerPort = {
      run: vi.fn(async (args: RunEngineArgs) => {
        received.push(args);
        return { result: 'ok' };
      }),
    };
    await new TurnRunnerService(engine, repo).runTurn({
      ...baseInput,
      sandbox: rowSourced,
      evidenceDir: '/context/evidence/010-backend',
    });

    expect(received[0].target?.evidenceDir).toBe('/context/evidence/010-backend');
  });

  it('omits evidenceDir on the target when the turn passes none', async () => {
    const { repo } = fakeSteps();
    const received: RunEngineArgs[] = [];
    const engine: EngineRunnerPort = {
      run: vi.fn(async (args: RunEngineArgs) => {
        received.push(args);
        return { result: 'ok' };
      }),
    };
    await new TurnRunnerService(engine, repo).runTurn({ ...baseInput, sandbox: rowSourced });

    expect(received[0].target?.evidenceDir).toBeUndefined();
  });
});
