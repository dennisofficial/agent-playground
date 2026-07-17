import {
  EngineAuthError,
  isEngineDetachedError,
  type EngineEvent,
  type EngineRunnerPort,
  type RunEngineArgs,
} from '@shared/engine';
import { agentMessage } from '@shared/prompt-kit/message';
import type { Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { TurnUsageProjector } from '../../analytics/turn-usage-projector.service';
import type { ThreadEntity } from '../../persistence/entities';
import type { FeatureSandbox } from '../git';
import { TurnRunnerService } from '../turn-runner.service';

/**
 * TurnRunnerService — DURABILITY of the resume handle. The point: a coding session must survive a halt
 * by CONTINUING, not respawning. That hinges on the engine `session_id` being persisted onto the THREAD
 * row (a thread's single step IS the thread row, so the driver's `stepId` is the thread's own id) the
 * instant it exists (turn START), so a mid-turn crash/kill/restart still has a resume handle.
 */

/** A fake threads repo capturing the last persisted session_id; `findOne` returns the prior one. */
function fakeSteps(priorSessionId: string | null = null) {
  const updates: Array<{ id: unknown; patch: { session_id?: string } }> = [];
  let current = priorSessionId;
  const repo = {
    findOne: vi.fn(async () =>
      current === null ? null : ({ session_id: current } as ThreadEntity),
    ),
    update: vi.fn(async (where: { id: unknown }, patch: { session_id?: string }) => {
      updates.push({ id: where.id, patch });
      if (patch.session_id) current = patch.session_id;
      return { affected: 1 } as never;
    }),
  } as unknown as Repository<ThreadEntity>;
  return { repo, updates, last: () => current };
}

function fakeUsage() {
  return {
    record: vi.fn(async () => undefined),
  } as unknown as TurnUsageProjector & { record: ReturnType<typeof vi.fn> };
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
    await new TurnRunnerService(engine, repo).runTurn({
      ...baseInput,
      sandbox: rowSourced,
    });

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
    await new TurnRunnerService(engine, repo).runTurn({
      ...baseInput,
      sandbox: rowSourced,
    });

    expect(received[0].target?.evidenceDir).toBeUndefined();
  });
});

describe('TurnRunnerService — provenance threading', () => {
  it('returns and records the credential id surfaced by a fresh engine run', async () => {
    const { repo } = fakeSteps();
    const usage = fakeUsage();
    const engine: EngineRunnerPort = {
      run: vi.fn(async () => ({
        result: 'ok',
        usage: { inputTokens: 10, outputTokens: 2 },
        credentialId: 'cred-fresh',
      })),
    };

    const res = await new TurnRunnerService(engine, repo, usage).runTurn({
      ...baseInput,
      turnMeta: {
        jobId: 'job-1',
        orgId: 'org-1',
        channel: 'repo-1',
        lane: 'thread:t1',
        kind: 'step',
      },
    });

    expect(res.credentialId).toBe('cred-fresh');
    expect(usage.record).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        orgId: 'org-1',
        lane: 'thread:t1',
        kind: 'step',
        engine: 'claude',
        credentialId: 'cred-fresh',
      }),
      expect.objectContaining({ inputTokens: 10, outputTokens: 2 }),
    );
  });

  it('records usage for a successful reattach with the dispatch credential id', async () => {
    const { repo } = fakeSteps();
    const usage = fakeUsage();
    const engine: EngineRunnerPort = {
      run: vi.fn(),
      reattach: vi.fn(async () => ({
        result: 'reattached',
        sessionId: 'sess-1',
        usage: { inputTokens: 8, outputTokens: 3 },
        credentialId: 'cred-reattach',
      })),
    };

    const res = await new TurnRunnerService(engine, repo, usage).reattach({
      turnId: 'turn-1',
      containerId: 'ctr-1',
      jobId: 'job-1',
      orgId: 'org-1',
      stepId: 'step-1',
      lane: 'thread:t1',
      kind: 'step',
      engine: 'claude',
      credentialId: 'cred-reattach',
    });

    expect(res.credentialId).toBe('cred-reattach');
    expect(engine.reattach).toHaveBeenCalledWith(
      'turn-1',
      'ctr-1',
      expect.objectContaining({ credentialId: 'cred-reattach' }),
    );
    expect(usage.record).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        orgId: 'org-1',
        lane: 'thread:t1',
        kind: 'step',
        engine: 'claude',
        credentialId: 'cred-reattach',
        metaTag: { phaseId: 'step-1' },
      }),
      expect.objectContaining({ inputTokens: 8, outputTokens: 3 }),
    );
  });

  it('does not record reattach usage when another finisher already claimed the turn', async () => {
    const { repo } = fakeSteps();
    const usage = fakeUsage();
    const engine: EngineRunnerPort = {
      run: vi.fn(),
      reattach: vi.fn(async () => ({
        result: 'lost',
        usage: { inputTokens: 1, outputTokens: 1 },
        credentialId: 'cred-lost',
        claimed: false,
      })),
    };

    await new TurnRunnerService(engine, repo, usage).reattach({
      turnId: 'turn-1',
      containerId: 'ctr-1',
      jobId: 'job-1',
      credentialId: 'cred-lost',
    });

    expect(usage.record).not.toHaveBeenCalled();
  });

  it('refuses a concurrent second reattach of the same turn (double-attach → single delivery)', async () => {
    const { repo } = fakeSteps();
    // Mirror RedisEngineRunner's real per-process attach Set so `tryClaimAttach` has genuine check-and-add
    // semantics: the guard must win synchronously, before the second attach can start a duplicate tail loop.
    const attached = new Set<string>();
    const deliveries: string[] = [];
    let releaseFirst!: () => void;
    const firstInFlight = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const engine: EngineRunnerPort = {
      run: vi.fn(),
      tryClaimAttach: (t: string) => (attached.has(t) ? false : (attached.add(t), true)),
      releaseAttach: (t: string) => {
        attached.delete(t);
      },
      reattach: vi.fn(
        async (
          turnId: string,
          _containerId: string,
          args: { onEvent?: (e: EngineEvent) => void },
        ) => {
          // Deliver one event, then stay "live" until the test releases us — so the SECOND reattach
          // genuinely overlaps a still-attached first loop (the exact double-delivery hazard).
          args.onEvent?.({ kind: 'text', text: `evt-${turnId}` });
          deliveries.push(turnId);
          await firstInFlight;
          return { result: 'ok', sessionId: 's1' };
        },
      ),
    };
    const svc = new TurnRunnerService(engine, repo);
    const input = { turnId: 'turn-1', containerId: 'ctr-1', jobId: 'job-1' };

    // First reattach claims the slot synchronously, then blocks inside the (fake) engine loop.
    const first = svc.reattach(input);
    // The concurrent second attach must be refused BEFORE engine.reattach runs a second time.
    const secondErr = await svc.reattach(input).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isEngineDetachedError(secondErr)).toBe(true);

    releaseFirst();
    await first;

    // Exactly one attach loop ran, and its event was delivered exactly once — no doubling.
    expect(engine.reattach).toHaveBeenCalledTimes(1);
    expect(deliveries).toEqual(['turn-1']);
    // The winning attacher released its slot on completion, so a later, non-overlapping reattach can proceed.
    expect(attached.has('turn-1')).toBe(false);
  });
});
