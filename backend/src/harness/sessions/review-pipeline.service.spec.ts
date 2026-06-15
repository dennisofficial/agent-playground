import { describe, expect, it, vi } from 'vitest';
import { ReviewPipelineService } from './review-pipeline.service';
import type { Session } from './session-registry.port';

/**
 * The harness-driven PR self-review pipeline. The engine runs and GitHub are stubbed; the SUBJECT is
 * the control flow: a clean review completes the owner and (when last) opens+readies the PR, a publish
 * conflict blocks without completing, and the integration barrier only trips when EVERY owner is done.
 */

const SHARED = 'shared/feature';

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    task: 'Build the thing',
    worktreeId: 'wt-1',
    status: 'idle',
    notifyThread: 'dev:root',
    ownerBot: 'alex',
    team: 'T1',
    project: 'proj',
    engine: 'claude',
    mode: 'execute',
    turns: 1,
    boardTaskId: 7,
    ...over,
  } as Session;
}

function build(opts: {
  reviewVerdict?: string; // text the review engine returns
  publishIntegrated?: boolean;
  ownerStatuses?: Record<string, string>; // employee -> owner_status across the task
  worktreeShared?: string | null; // worktree's current sharedBranch (null → not yet promoted)
  selfHeal?: // result of ensureSharedAtBase when the worktree has no shared branch
    | { ok: true; sharedBranch: string }
    | { ok: false; reason: string };
  noAnchor?: boolean; // plan rows carry no executeWorktreeId/sharedBranch
  recNull?: boolean; // projectRecordFor returns undefined (unregistered)
  openPrThrows?: boolean; // openPullRequest rejects
}) {
  const ownerStatuses = opts.ownerStatuses ?? { alex: 'executing' };
  const worktreeShared =
    opts.worktreeShared === undefined ? SHARED : opts.worktreeShared;
  const engineRun = vi.fn(async () => ({
    result: opts.reviewVerdict ?? 'Looks good.\nVERDICT: PASS',
  }));
  const engines = { get: () => ({ run: engineRun }) } as never;

  const reviewSpecCap = {
    name: 'self_review',
    spec: () => ({ engine: 'codex', systemPrompt: 'sp' }),
  };
  const bot = {
    id: 'alex',
    capabilities: () => [reviewSpecCap],
    executeEngine: () => ({ engine: 'claude', systemPrompt: 'sp' }),
  };
  const employees = {
    byId: () => bot,
    context: () => ({}),
  } as never;

  const credCtx = { run: (_c: unknown, fn: () => unknown) => fn() } as never;
  const creds = { resolve: async () => ({ anthropic: 'k', openai: 'k' }) } as never;

  const setOwnerStatus = vi.fn(
    async (_t: string, _id: number, emp: string, s: string) => {
      ownerStatuses[emp] = s;
      return undefined;
    },
  );
  const setExecuteContext = vi.fn(async () => undefined);
  const plans = {
    listForTask: async () =>
      Object.entries(ownerStatuses).map(([employee, ownerStatus]) => ({
        employee,
        ownerStatus,
        executeWorktreeId: opts.noAnchor ? undefined : 'wt-1',
        sharedBranch: opts.noAnchor ? undefined : SHARED,
        sessionId: 'sess-1',
      })),
    allOwnersComplete: async () =>
      Object.values(ownerStatuses).every((s) => s === 'complete'),
    setOwnerStatus,
    setExecuteContext,
    setPrUrl: vi.fn(async () => undefined),
  } as never;

  const transition = vi.fn(async () => ({ id: 7 }));
  const board = {
    get: async () => ({ id: 7, title: 'Build', description: 'desc', status: 'executing' }),
    transition,
  } as never;

  const publish = vi.fn(async () => ({
    integrated: opts.publishIntegrated ?? true,
    sharedBranch: SHARED,
    files: opts.publishIntegrated === false ? ['a.ts'] : undefined,
  }));
  // A single worktree instance so a self-heal mutation (set sharedBranch) is visible to the captured ref.
  const worktree: { sharedBranch: string | null } & Record<string, unknown> = {
    id: 'wt-1',
    path: '/tmp/wt',
    sharedBranch: worktreeShared,
    branch: 'agent/alex/7',
  };
  const ensureSharedAtBase = vi.fn(async () => {
    const r = opts.selfHeal ?? { ok: true, sharedBranch: SHARED };
    if (r.ok) worktree.sharedBranch = r.sharedBranch;
    return r;
  });
  const worktrees = {
    get: () => worktree,
    ensureSharedAtBase,
    sharedRef: async () => 'deadbeef',
    ownerDiff: async () => ({ range: 'deadbeef...agent/alex/7', files: ['a.ts'] }),
    publish,
    projectRecordFor: async () =>
      opts.recNull
        ? undefined
        : {
            teamId: 'T1',
            tokenName: undefined,
            gitUrl: 'https://github.com/o/r',
            defaultBranch: 'main',
          },
    pushSharedToOrigin: async () => ({ sharedBranch: SHARED, gitUrl: 'https://github.com/o/r' }),
  } as never;

  const tokens = { resolve: async () => ({ name: 'default', token: 'tok' }) } as never;
  const openPullRequest = vi.fn(async () => {
    if (opts.openPrThrows) throw new Error('github 500');
    return {
      url: 'https://github.com/o/r/pull/1',
      number: 1,
      existing: false,
    };
  });
  const markReadyForReview = vi.fn(async () => ({ isDraft: false }));
  const github = {
    openPullRequest,
    listOpenPullRequests: async () => [{ number: 1, headBranch: SHARED }],
    markReadyForReview,
  } as never;

  const boardEmit = vi.fn();
  const boardEvents = { emit: boardEmit } as never;
  const resumeInternal = vi.fn(async () => makeSession());
  const runner = { resumeInternal } as never;
  const sessions = { get: async () => makeSession() } as never;

  const svc = new ReviewPipelineService(
    engines,
    employees,
    credCtx,
    creds,
    worktrees,
    tokens,
    github,
    board,
    plans,
    boardEvents,
    runner,
    sessions,
  );
  return {
    svc,
    engineRun,
    setOwnerStatus,
    setExecuteContext,
    ensureSharedAtBase,
    transition,
    publish,
    openPullRequest,
    markReadyForReview,
    boardEmit,
    resumeInternal,
    ownerStatuses,
  };
}

/** All employee names that received a board event of `kind`. */
function emittedFor(boardEmit: { mock: { calls: unknown[][] } }, kind: string) {
  return boardEmit.mock.calls
    .map((c) => c[0] as { kind: string; employee: string })
    .filter((e) => e.kind === kind)
    .map((e) => e.employee);
}

describe('ReviewPipelineService.reviewOwner', () => {
  it('clean review (sole owner) → completes the owner, opens + readies the PR, ticket → in_review', async () => {
    const f = build({ reviewVerdict: 'All good.\nVERDICT: PASS' });
    const out = await f.svc.reviewOwner(makeSession());
    expect(out).toEqual({ kind: 'complete' });
    expect(f.setOwnerStatus).toHaveBeenCalledWith('T1', 7, 'alex', 'complete');
    // Integration barrier ran: executing→self_review then self_review→in_review.
    expect(f.transition).toHaveBeenCalledWith('T1', 7, 'executing', {
      status: 'self_review',
    });
    expect(f.transition).toHaveBeenCalledWith('T1', 7, 'self_review', {
      status: 'in_review',
    });
    expect(f.openPullRequest).toHaveBeenCalled();
    expect(f.markReadyForReview).toHaveBeenCalled();
    expect(f.boardEmit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'pr-ready' }),
    );
  });

  it('a publish conflict blocks the owner and never completes or opens a PR', async () => {
    const f = build({
      reviewVerdict: 'ok\nVERDICT: PASS',
      publishIntegrated: false,
    });
    const out = await f.svc.reviewOwner(makeSession());
    expect(out).toEqual({ kind: 'blocked', reason: 'publish conflict' });
    expect(f.setOwnerStatus).toHaveBeenCalledWith('T1', 7, 'alex', 'blocked');
    expect(f.setOwnerStatus).not.toHaveBeenCalledWith('T1', 7, 'alex', 'complete');
    expect(f.openPullRequest).not.toHaveBeenCalled();
    // The owner is seeded to resolve + a recovery resume runs.
    expect(f.boardEmit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'self-review-failed' }),
    );
    expect(f.resumeInternal).toHaveBeenCalled();
  });

  it('review CHANGES then a bounded fix loop runs before giving up', async () => {
    // Always CHANGES → exhausts the 2 fix passes and blocks (never completes).
    const f = build({ reviewVerdict: 'Fix X\nVERDICT: CHANGES' });
    const out = await f.svc.reviewOwner(makeSession());
    expect(out).toEqual({ kind: 'blocked', reason: 'fix loop exhausted' });
    expect(f.resumeInternal).toHaveBeenCalledTimes(2); // MAX_FIX_PASSES
    expect(f.openPullRequest).not.toHaveBeenCalled();
  });

  it('multi-owner: a clean owner completes but does NOT trip integration while a teammate is still executing', async () => {
    const f = build({
      reviewVerdict: 'ok\nVERDICT: PASS',
      ownerStatuses: { alex: 'executing', riley: 'executing' },
    });
    const out = await f.svc.reviewOwner(makeSession());
    expect(out).toEqual({ kind: 'complete' });
    expect(f.setOwnerStatus).toHaveBeenCalledWith('T1', 7, 'alex', 'complete');
    // riley still 'executing' → allOwnersComplete false → no PR, no self_review flip.
    expect(f.openPullRequest).not.toHaveBeenCalled();
    expect(f.transition).not.toHaveBeenCalledWith('T1', 7, 'executing', {
      status: 'self_review',
    });
  });

  it('integration barrier fans pr-opened + pr-ready to EVERY owner, not just the anchor', async () => {
    const f = build({
      reviewVerdict: 'ok\nVERDICT: PASS',
      ownerStatuses: { alex: 'complete', riley: 'complete' },
    });
    await f.svc.integrate('T1', 7);
    expect(emittedFor(f.boardEmit, 'pr-opened')).toEqual(
      expect.arrayContaining(['alex', 'riley']),
    );
    expect(emittedFor(f.boardEmit, 'pr-ready')).toEqual(
      expect.arrayContaining(['alex', 'riley']),
    );
  });

  it('no shared branch → self-heals at the base, reviews, and completes (not a silent block)', async () => {
    const f = build({
      reviewVerdict: 'ok\nVERDICT: PASS',
      worktreeShared: null,
      selfHeal: { ok: true, sharedBranch: SHARED },
    });
    const out = await f.svc.reviewOwner(makeSession());
    expect(out).toEqual({ kind: 'complete' });
    expect(f.ensureSharedAtBase).toHaveBeenCalledWith('wt-1', 'ticket-7');
    expect(f.setOwnerStatus).toHaveBeenCalledWith('T1', 7, 'alex', 'complete');
    expect(f.setOwnerStatus).not.toHaveBeenCalledWith('T1', 7, 'alex', 'blocked');
  });

  it('self-heal failure → blocks the owner AND narrates (never silent)', async () => {
    const f = build({
      worktreeShared: null,
      selfHeal: { ok: false, reason: 'no registered GitHub repo matches worktree wt-1' },
    });
    const out = await f.svc.reviewOwner(makeSession());
    expect(out.kind).toBe('blocked');
    expect(f.setOwnerStatus).toHaveBeenCalledWith('T1', 7, 'alex', 'blocked');
    expect(f.boardEmit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'self-review-failed', employee: 'alex' }),
    );
    expect(f.publish).not.toHaveBeenCalled();
  });

  it('backfills the plan row execute context before publishing (so integrate finds an anchor)', async () => {
    const f = build({ reviewVerdict: 'ok\nVERDICT: PASS' });
    await f.svc.reviewOwner(makeSession());
    expect(f.setExecuteContext).toHaveBeenCalledWith('T1', 7, 'alex', {
      executeWorktreeId: 'wt-1',
      sharedBranch: SHARED,
    });
  });
});

describe('ReviewPipelineService.integrate (loud + recoverable dead ends)', () => {
  it('no anchor → narrates to all owners; ticket stays executing (no self_review flip)', async () => {
    const f = build({
      ownerStatuses: { alex: 'complete', riley: 'complete' },
      noAnchor: true,
    });
    await f.svc.integrate('T1', 7);
    expect(emittedFor(f.boardEmit, 'self-review-failed')).toEqual(
      expect.arrayContaining(['alex', 'riley']),
    );
    expect(f.transition).not.toHaveBeenCalledWith('T1', 7, 'executing', {
      status: 'self_review',
    });
  });

  it('unregistered repo → rolls self_review back to executing AND narrates to all owners', async () => {
    const f = build({
      ownerStatuses: { alex: 'complete', riley: 'complete' },
      recNull: true,
    });
    await f.svc.integrate('T1', 7);
    expect(f.transition).toHaveBeenCalledWith('T1', 7, 'self_review', {
      status: 'executing',
    });
    expect(emittedFor(f.boardEmit, 'self-review-failed')).toEqual(
      expect.arrayContaining(['alex', 'riley']),
    );
    expect(f.markReadyForReview).not.toHaveBeenCalled();
  });

  it('PR-open failure → rolls back to executing AND narrates (resubmittable)', async () => {
    const f = build({
      ownerStatuses: { alex: 'complete' },
      openPrThrows: true,
    });
    await f.svc.integrate('T1', 7);
    expect(f.transition).toHaveBeenCalledWith('T1', 7, 'self_review', {
      status: 'executing',
    });
    expect(f.boardEmit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'self-review-failed' }),
    );
  });

  it('integration review flags changes → rolls back to executing AND narrates', async () => {
    const f = build({
      ownerStatuses: { alex: 'complete' },
      reviewVerdict: 'Combined work breaks X\nVERDICT: CHANGES',
    });
    await f.svc.integrate('T1', 7);
    expect(f.transition).toHaveBeenCalledWith('T1', 7, 'self_review', {
      status: 'executing',
    });
    expect(f.markReadyForReview).not.toHaveBeenCalled();
    expect(f.boardEmit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'self-review-failed' }),
    );
  });
});
