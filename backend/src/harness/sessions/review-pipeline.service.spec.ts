import { describe, expect, it, vi } from 'vitest';
import { ReviewPipelineService } from './review-pipeline.service';
import type { Session } from './session-registry.port';

/**
 * The harness-driven PR self-review pipeline. The engine runs and GitHub are stubbed; the SUBJECT is
 * the control flow: a clean per-owner review completes the owner, the integration barrier (when last
 * owner done) opens the draft PR + reviews but no longer JUDGES — it parks the findings under a note
 * id and hands the ship-or-fix decision to the owner (the #49 loop fix). Infra dead ends still roll
 * back recoverably; a publish conflict blocks without completing.
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
  assignee?: string; // board task assignee (the ship decision owner)
  noteAddFails?: boolean; // TicketNoteStore.add throws (findings can't be parked)
  mode?: 'advisory' | 'gated'; // INTEGRATION_REVIEW_MODE (default advisory)
  markReadyThrows?: boolean; // markReadyForReview rejects (advisory loud-fail path)
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
    get: async () => ({
      id: 7,
      title: 'Build',
      description: 'desc',
      status: 'executing',
      assignee: opts.assignee,
    }),
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
  const markReadyForReview = vi.fn(async () => {
    if (opts.markReadyThrows) throw new Error('github 500');
    return { isDraft: false };
  });
  const commentOnPullRequest = vi.fn(async () => undefined);
  const listOpenPullRequests = vi.fn(async () => [{ number: 1, headBranch: SHARED }]);
  const github = {
    openPullRequest,
    listOpenPullRequests,
    markReadyForReview,
    commentOnPullRequest,
  } as never;

  const noteAdd = vi.fn(async (_t: string, _id: number, author: string, body: string) => {
    if (opts.noteAddFails) throw new Error('db down');
    return { id: 42, taskId: 7, author, body, createdAt: '' };
  });
  const noteGet = vi.fn(async () => ({
    id: 42,
    taskId: 7,
    author: 'alex',
    body: 'findings',
    createdAt: '',
  }));
  const notes = { add: noteAdd, get: noteGet } as never;

  const boardEmit = vi.fn();
  const boardEvents = { emit: boardEmit } as never;
  const resumeInternal = vi.fn(async () => makeSession());
  const runner = { resumeInternal } as never;
  const sessions = { get: async () => makeSession() } as never;
  const env = {
    get: (k: string) =>
      k === 'INTEGRATION_REVIEW_MODE' ? (opts.mode ?? 'advisory') : undefined,
  } as never;

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
    notes,
    boardEvents,
    runner,
    env,
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
    listOpenPullRequests,
    markReadyForReview,
    commentOnPullRequest,
    boardEmit,
    resumeInternal,
    noteAdd,
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
  it('gated mode (sole owner) → completes the owner, opens the PR, parks findings + hands the ship decision to the owner (NO auto-ready)', async () => {
    const f = build({ reviewVerdict: 'All good.\nVERDICT: PASS', mode: 'gated' });
    const out = await f.svc.reviewOwner(makeSession());
    expect(out).toEqual({ kind: 'complete' });
    expect(f.setOwnerStatus).toHaveBeenCalledWith('T1', 7, 'alex', 'complete');
    // Integration barrier opened the draft PR + ran the review, then STOPPED deciding.
    expect(f.transition).toHaveBeenCalledWith('T1', 7, 'executing', {
      status: 'self_review',
    });
    expect(f.openPullRequest).toHaveBeenCalled();
    // The harness no longer judges/readies: PR stays draft, ticket stays self_review, owner decides.
    expect(f.transition).not.toHaveBeenCalledWith('T1', 7, 'self_review', {
      status: 'in_review',
    });
    expect(f.markReadyForReview).not.toHaveBeenCalled();
    // Findings parked under an id; the decision owner is woken with the note id + mechanical handles.
    expect(f.noteAdd).toHaveBeenCalled();
    expect(f.boardEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'self-review-ready',
        employee: 'alex',
        noteId: 42,
        worktreeId: 'wt-1',
      }),
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

  it('gated mode: fans pr-opened to EVERY owner, but the ship decision goes to a SINGLE owner', async () => {
    const f = build({
      reviewVerdict: 'ok\nVERDICT: PASS',
      ownerStatuses: { alex: 'complete', riley: 'complete' },
      mode: 'gated',
    });
    await f.svc.integrate('T1', 7);
    expect(emittedFor(f.boardEmit, 'pr-opened')).toEqual(
      expect.arrayContaining(['alex', 'riley']),
    );
    // Exactly one decision owner is asked to ship-or-fix (mark_pr_ready authorizes one owner).
    expect(emittedFor(f.boardEmit, 'self-review-ready')).toHaveLength(1);
    // gated never auto-readies, so it never emits pr-ready (mark_pr_ready does that).
    expect(emittedFor(f.boardEmit, 'pr-ready')).toEqual([]);
    expect(f.markReadyForReview).not.toHaveBeenCalled();
  });

  it('gated mode: routes the ship decision to the board ASSIGNEE when set', async () => {
    const f = build({
      reviewVerdict: 'ok\nVERDICT: PASS',
      ownerStatuses: { alex: 'complete', riley: 'complete' },
      assignee: 'riley',
      mode: 'gated',
    });
    await f.svc.integrate('T1', 7);
    expect(emittedFor(f.boardEmit, 'self-review-ready')).toEqual(['riley']);
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

  it('gated mode: integration review flagging issues does NOT roll back (the #49 loop fix) — it parks findings + hands the decision to the owner', async () => {
    const f = build({
      ownerStatuses: { alex: 'complete', riley: 'complete' },
      reviewVerdict: 'Combined work breaks X\nVERDICT: CHANGES',
      mode: 'gated',
    });
    await f.svc.integrate('T1', 7);
    // No rollback to executing on a (non-deterministic) review verdict — that was the infinite loop.
    expect(f.transition).not.toHaveBeenCalledWith('T1', 7, 'self_review', {
      status: 'executing',
    });
    expect(f.markReadyForReview).not.toHaveBeenCalled();
    // The actual critique is parked (relayed), not discarded, and the owner is asked to decide.
    expect(f.noteAdd).toHaveBeenCalledWith(
      'T1',
      7,
      'alex',
      expect.stringContaining('Combined work breaks X'),
    );
    expect(f.boardEmit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'self-review-ready', noteId: 42 }),
    );
    expect(emittedFor(f.boardEmit, 'self-review-failed')).toEqual([]);
  });

  it('gated mode: an empty review still parks a note and seeds the decision (clean is still owner-decided)', async () => {
    const f = build({
      ownerStatuses: { alex: 'complete' },
      reviewVerdict: '',
      mode: 'gated',
    });
    await f.svc.integrate('T1', 7);
    expect(f.noteAdd).toHaveBeenCalledWith(
      'T1',
      7,
      'alex',
      expect.stringContaining('no issues'),
    );
    expect(f.boardEmit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'self-review-ready' }),
    );
  });

  it('gated mode: a failed findings write IS a recoverable dead end → rolls back to executing + narrates', async () => {
    const f = build({
      ownerStatuses: { alex: 'complete' },
      reviewVerdict: 'ok\nVERDICT: PASS',
      noteAddFails: true,
      mode: 'gated',
    });
    await f.svc.integrate('T1', 7);
    expect(f.transition).toHaveBeenCalledWith('T1', 7, 'self_review', {
      status: 'executing',
    });
    expect(emittedFor(f.boardEmit, 'self-review-failed')).toEqual(
      expect.arrayContaining(['alex']),
    );
    expect(f.boardEmit).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'self-review-ready' }),
    );
  });

  it('gated mode: integrate() never auto-readies — no markReady calls, no self_review→in_review (hands off instead)', async () => {
    const f = build({
      ownerStatuses: { alex: 'complete', riley: 'complete' },
      reviewVerdict: 'ok\nVERDICT: PASS',
      mode: 'gated',
    });
    await f.svc.integrate('T1', 7);
    expect(f.markReadyForReview).not.toHaveBeenCalled();
    expect(f.transition).not.toHaveBeenCalledWith('T1', 7, 'self_review', {
      status: 'in_review',
    });
    // Instead it opens the DRAFT PR and hands the ship decision to one owner.
    expect(f.openPullRequest).toHaveBeenCalled();
    expect(emittedFor(f.boardEmit, 'self-review-ready')).toHaveLength(1);
  });
});

describe('ReviewPipelineService.integrate (advisory mode — default, max autonomy)', () => {
  it('sole owner → ships straight to ready: auto-readies the PR, ticket → in_review, pr-ready, no integration review, no decision seed', async () => {
    const f = build({ reviewVerdict: 'ok\nVERDICT: PASS' }); // default advisory, sole owner
    const out = await f.svc.reviewOwner(makeSession());
    expect(out).toEqual({ kind: 'complete' });
    expect(f.markReadyForReview).toHaveBeenCalled();
    expect(f.transition).toHaveBeenCalledWith('T1', 7, 'self_review', {
      status: 'in_review',
    });
    expect(emittedFor(f.boardEmit, 'pr-ready')).toContain('alex');
    expect(emittedFor(f.boardEmit, 'self-review-ready')).toEqual([]);
    // sole-owner skips the integration review (per-owner pass already covered the whole diff).
    expect(f.engineRun).toHaveBeenCalledTimes(1);
    expect(f.commentOnPullRequest).not.toHaveBeenCalled();
  });

  it('multi-owner review that flags issues → ships the PR ANYWAY and posts findings as a PR comment + ticket note (advisory never blocks)', async () => {
    const f = build({
      ownerStatuses: { alex: 'complete', riley: 'complete' },
      reviewVerdict: 'Contract mismatch in X\nVERDICT: CHANGES',
    });
    await f.svc.integrate('T1', 7);
    expect(f.markReadyForReview).toHaveBeenCalled();
    expect(f.transition).toHaveBeenCalledWith('T1', 7, 'self_review', {
      status: 'in_review',
    });
    expect(f.commentOnPullRequest).toHaveBeenCalledWith(
      'tok',
      expect.objectContaining({
        body: expect.stringContaining('Contract mismatch in X'),
      }),
    );
    expect(f.noteAdd).toHaveBeenCalledWith(
      'T1',
      7,
      'alex',
      expect.stringContaining('Contract mismatch in X'),
    );
    expect(emittedFor(f.boardEmit, 'pr-ready')).toEqual(
      expect.arrayContaining(['alex', 'riley']),
    );
    expect(emittedFor(f.boardEmit, 'self-review-ready')).toEqual([]);
  });

  it('a clean multi-owner review ships with NO PR comment (no noise)', async () => {
    const f = build({
      ownerStatuses: { alex: 'complete', riley: 'complete' },
      reviewVerdict: 'All good\nVERDICT: PASS',
    });
    await f.svc.integrate('T1', 7);
    expect(f.markReadyForReview).toHaveBeenCalled();
    expect(f.commentOnPullRequest).not.toHaveBeenCalled();
    expect(emittedFor(f.boardEmit, 'pr-ready')).toEqual(
      expect.arrayContaining(['alex', 'riley']),
    );
  });

  it('a failed mark-ready does NOT advance the ticket — loud-fail, no silent draft-stuck (the #38 bug)', async () => {
    const f = build({
      ownerStatuses: { alex: 'complete' },
      markReadyThrows: true,
    });
    await f.svc.integrate('T1', 7);
    // Rolled back to executing (recoverable), NOT advanced to in_review with a still-draft PR.
    expect(f.transition).toHaveBeenCalledWith('T1', 7, 'self_review', {
      status: 'executing',
    });
    expect(f.transition).not.toHaveBeenCalledWith('T1', 7, 'self_review', {
      status: 'in_review',
    });
    expect(emittedFor(f.boardEmit, 'self-review-failed')).toEqual(
      expect.arrayContaining(['alex']),
    );
  });
});
