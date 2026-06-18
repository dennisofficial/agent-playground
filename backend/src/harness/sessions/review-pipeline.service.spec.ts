import { describe, expect, it, vi } from 'vitest';
import { ReviewPipelineService } from './review-pipeline.service';
import type { Session } from './session-registry.port';

/**
 * The harness-driven PR self-review pipeline, single-owner + sibling-aware model. Engine runs and
 * GitHub are stubbed; the SUBJECT is the control flow: a solo ticket reviews its own diff then ships;
 * tickets sharing a `shared_slug` land on one PR and ship together ONLY once all are published (the
 * last to finish ships, flipping every sibling → in_review). The harness never judges the integration
 * review pass/fail (the #49 loop); advisory ships + comments findings, gated seeds the owner. Infra
 * dead ends roll back recoverably.
 */

const SHARED = 'shared/feature';
const PR = { number: 1, headBranch: SHARED, url: 'https://github.com/o/r/pull/1' };

interface Ticket {
  id: number;
  status: string;
  assignee: string;
  project: string;
  title: string;
  description: string;
  sharedSlug?: string;
}

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    task: 'Build the thing',
    workspaceId: 'ws-1',
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

/** A plan row (anchor) for a ticket. */
const planRow = (over: Partial<Record<string, unknown>> = {}) => ({
  employee: 'alex',
  ownerStatus: 'complete',
  executeWorkspaceId: 'ws-1',
  sharedBranch: SHARED,
  sessionId: 'sess-1',
  ...over,
});

function build(opts: {
  tickets?: Ticket[]; // board state (default: one solo ticket #7)
  plansByTask?: Record<number, Array<Record<string, unknown>>>;
  reviewVerdict?: string;
  publishIntegrated?: boolean;
  workspaceShared?: string | null;
  selfHeal?: { ok: true; sharedBranch: string } | { ok: false; reason: string };
  noAnchor?: boolean;
  recNull?: boolean;
  openPrThrows?: boolean;
  markReadyThrows?: boolean;
  mode?: 'advisory' | 'gated';
}) {
  const tickets = new Map<number, Ticket>();
  const seed = opts.tickets ?? [
    { id: 7, status: 'executing', assignee: 'alex', project: 'proj', title: 'Build', description: 'desc' },
  ];
  for (const t of seed) tickets.set(t.id, { ...t });

  const plansByTask: Record<number, Array<Record<string, unknown>>> =
    opts.plansByTask ?? {
      7: opts.noAnchor
        ? [planRow({ executeWorkspaceId: undefined, sharedBranch: undefined })]
        : [planRow()],
    };

  const engineRun = vi.fn(async () => ({
    result: opts.reviewVerdict ?? 'Looks good.\nVERDICT: PASS',
  }));
  // TurnExecutor double: Phase 7 routes LOCAL (isContainerized=false) → engineRun(args), the verbatim
  // local-branch delegation, so the runReview assertions stay byte-identical.
  const turnExecutor = {
    run: (_ctx: unknown, _name: unknown, _args: unknown) => engineRun(),
  } as never;

  const reviewSpecCap = { name: 'self_review', spec: () => ({ engine: 'codex', systemPrompt: 'sp' }) };
  const bot = {
    id: 'alex',
    capabilities: () => [reviewSpecCap],
    executeEngine: () => ({ engine: 'claude', systemPrompt: 'sp' }),
  };
  const employees = { byId: () => bot, context: () => ({}) } as never;

  const credCtx = { run: (_c: unknown, fn: () => unknown) => fn() } as never;
  const creds = { resolve: async () => ({ anthropic: 'k', openai: 'k' }) } as never;

  const setOwnerStatus = vi.fn(async (_t: string, id: number, s: string) => {
    const p = (plansByTask[id] ?? [])[0];
    if (p) (p as Record<string, unknown>).ownerStatus = s;
  });
  const plans = {
    listForTask: async (_t: string, id: number) => plansByTask[id] ?? [],
    get: async (_t: string, id: number) => (plansByTask[id] ?? [])[0],
    setOwnerStatus,
    setExecuteContext: vi.fn(async () => undefined),
    setPrUrl: vi.fn(async () => undefined),
  } as never;

  const transition = vi.fn(async (_t: string, id: number, from: string, patch: { status: string }) => {
    const t = tickets.get(id);
    if (t && t.status === from) {
      t.status = patch.status;
      return { ...t };
    }
    return undefined;
  });
  const board = {
    get: async (_t: string, id: number) => tickets.get(id),
    list: async (q: { sharedSlug?: string; project?: string }) =>
      [...tickets.values()].filter(
        (t) =>
          (!q.sharedSlug || t.sharedSlug === q.sharedSlug) &&
          (!q.project || t.project === q.project),
      ),
    transition,
  } as never;

  const publish = vi.fn(async () => ({
    integrated: opts.publishIntegrated ?? true,
    sharedBranch: SHARED,
    files: opts.publishIntegrated === false ? ['a.ts'] : undefined,
  }));
  const workspaceShared = opts.workspaceShared === undefined ? SHARED : opts.workspaceShared;
  const workspace: { sharedBranch: string | null } & Record<string, unknown> = {
    id: 'ws-1',
    path: '/tmp/ws',
    sharedBranch: workspaceShared,
    branch: 'agent/alex/7',
  };
  const ensureSharedAtBase = vi.fn(async () => {
    const r = opts.selfHeal ?? { ok: true, sharedBranch: SHARED };
    if (r.ok) workspace.sharedBranch = r.sharedBranch;
    return r;
  });
  const workspaces = {
    get: () => workspace,
    ensureSharedAtBase,
    sharedRef: async () => 'deadbeef',
    ownerDiff: async () => ({ range: 'deadbeef...agent/alex/7', files: ['a.ts'] }),
    publish,
    projectRecordFor: async () =>
      opts.recNull
        ? undefined
        : { teamId: 'T1', tokenName: undefined, gitUrl: 'https://github.com/o/r', defaultBranch: 'main' },
    pushSharedToOrigin: async () => ({ sharedBranch: SHARED, gitUrl: 'https://github.com/o/r' }),
  } as never;

  const tokens = { resolve: async () => ({ name: 'default', token: 'tok' }) } as never;
  const openPullRequest = vi.fn(async () => {
    if (opts.openPrThrows) throw new Error('github 500');
    return { url: PR.url, number: PR.number, existing: false };
  });
  const markReadyForReview = vi.fn(async () => {
    if (opts.markReadyThrows) throw new Error('github 500');
    return { isDraft: false };
  });
  const updatePullRequest = vi.fn(async () => undefined);
  const commentOnPullRequest = vi.fn(async () => undefined);
  const listOpenPullRequests = vi.fn(async () => [PR]);
  const github = {
    openPullRequest,
    listOpenPullRequests,
    markReadyForReview,
    updatePullRequest,
    commentOnPullRequest,
  } as never;

  const noteAdd = vi.fn(async (_t: string, _id: number, author: string, body: string) => ({
    id: 42,
    taskId: 7,
    author,
    body,
    createdAt: '',
  }));
  const notes = { add: noteAdd, get: vi.fn() } as never;

  const boardEmit = vi.fn();
  const boardEvents = { emit: boardEmit } as never;
  const resumeInternal = vi.fn(async () => makeSession());
  const runner = { resumeInternal } as never;
  const sessions = {
    get: async (sid: string) => makeSession({ id: sid, notifyThread: `room-${sid}` }),
  } as never;
  const env = {
    get: (k: string) =>
      k === 'INTEGRATION_REVIEW_MODE' ? (opts.mode ?? 'advisory') : undefined,
  } as never;

  const svc = new ReviewPipelineService(
    turnExecutor,
    employees,
    credCtx,
    creds,
    workspaces,
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
    ensureSharedAtBase,
    transition,
    publish,
    openPullRequest,
    markReadyForReview,
    updatePullRequest,
    commentOnPullRequest,
    boardEmit,
    resumeInternal,
    noteAdd,
    tickets,
  };
}

/** Board events of `kind` → the taskIds (or employees) they targeted. */
const eventsOf = (boardEmit: { mock: { calls: unknown[][] } }, kind: string) =>
  boardEmit.mock.calls
    .map((c) => c[0] as { kind: string; taskId: number; employee: string })
    .filter((e) => e.kind === kind);

describe('ReviewPipelineService.reviewOwner (per-owner review, unchanged)', () => {
  it('a publish conflict blocks the owner and never completes or opens a PR', async () => {
    const f = build({ reviewVerdict: 'ok\nVERDICT: PASS', publishIntegrated: false });
    const out = await f.svc.reviewOwner(makeSession());
    expect(out).toEqual({ kind: 'blocked', reason: 'publish conflict' });
    expect(f.setOwnerStatus).toHaveBeenCalledWith('T1', 7, 'blocked');
    expect(f.openPullRequest).not.toHaveBeenCalled();
    expect(eventsOf(f.boardEmit, 'self-review-failed').length).toBeGreaterThan(0);
    expect(f.resumeInternal).toHaveBeenCalled();
  });

  it('review CHANGES then a bounded fix loop runs before giving up', async () => {
    const f = build({ reviewVerdict: 'Fix X\nVERDICT: CHANGES' });
    const out = await f.svc.reviewOwner(makeSession());
    expect(out).toEqual({ kind: 'blocked', reason: 'fix loop exhausted' });
    expect(f.resumeInternal).toHaveBeenCalledTimes(2); // MAX_FIX_PASSES
    expect(f.openPullRequest).not.toHaveBeenCalled();
  });

  it('no shared branch → self-heals using the ticket slug, reviews, completes', async () => {
    const f = build({
      tickets: [
        { id: 7, status: 'executing', assignee: 'alex', project: 'proj', title: 'Build', description: 'desc', sharedSlug: 'feat' },
      ],
      reviewVerdict: 'ok\nVERDICT: PASS',
      workspaceShared: null,
      selfHeal: { ok: true, sharedBranch: SHARED },
    });
    const out = await f.svc.reviewOwner(makeSession());
    expect(out).toEqual({ kind: 'complete' });
    expect(f.ensureSharedAtBase).toHaveBeenCalledWith('ws-1', 'feat'); // slug, not ticket-7
  });
});

describe('ReviewPipelineService.integrate (advisory, solo ticket)', () => {
  it('reviews, ships straight to ready, ticket → in_review, pr-ready, no integration review', async () => {
    const f = build({ reviewVerdict: 'ok\nVERDICT: PASS' });
    const out = await f.svc.reviewOwner(makeSession());
    expect(out).toEqual({ kind: 'complete' });
    expect(f.markReadyForReview).toHaveBeenCalled();
    expect(f.transition).toHaveBeenCalledWith('T1', 7, 'self_review', { status: 'in_review' });
    expect(eventsOf(f.boardEmit, 'pr-ready').map((e) => e.taskId)).toEqual([7]);
    expect(eventsOf(f.boardEmit, 'self-review-ready')).toEqual([]);
    expect(f.engineRun).toHaveBeenCalledTimes(1); // per-owner only; solo skips the integration review
    expect(f.commentOnPullRequest).not.toHaveBeenCalled();
    expect(f.updatePullRequest).not.toHaveBeenCalled(); // single ticket → no aggregate metadata
  });

  it('no anchor → narrates to the owner; ticket stays executing (no self_review flip)', async () => {
    const f = build({ noAnchor: true });
    await f.svc.integrate('T1', 7);
    expect(eventsOf(f.boardEmit, 'self-review-failed').map((e) => e.taskId)).toEqual([7]);
    expect(f.transition).not.toHaveBeenCalledWith('T1', 7, 'executing', { status: 'self_review' });
  });

  it('unregistered repo → rolls self_review back to executing AND narrates', async () => {
    const f = build({ recNull: true });
    await f.svc.integrate('T1', 7);
    expect(f.transition).toHaveBeenCalledWith('T1', 7, 'self_review', { status: 'executing' });
    expect(eventsOf(f.boardEmit, 'self-review-failed').length).toBeGreaterThan(0);
    expect(f.markReadyForReview).not.toHaveBeenCalled();
  });

  it('mark-ready failure does NOT advance the ticket — loud-fail rollback (the #38 bug)', async () => {
    const f = build({ markReadyThrows: true });
    await f.svc.integrate('T1', 7);
    expect(f.transition).toHaveBeenCalledWith('T1', 7, 'self_review', { status: 'executing' });
    expect(f.transition).not.toHaveBeenCalledWith('T1', 7, 'self_review', { status: 'in_review' });
    expect(eventsOf(f.boardEmit, 'self-review-failed').length).toBeGreaterThan(0);
  });
});

describe('ReviewPipelineService.integrate (sibling-aware shared feature)', () => {
  const sharedTickets = (): Ticket[] => [
    { id: 7, status: 'self_review', assignee: 'alex', project: 'proj', title: 'API', description: 'the api', sharedSlug: 'feat' },
    { id: 8, status: 'executing', assignee: 'riley', project: 'proj', title: 'UI', description: 'the ui', sharedSlug: 'feat' },
  ];
  const sharedPlans = () => ({
    7: [planRow({ employee: 'alex', sessionId: 'sess-1' })],
    8: [planRow({ employee: 'riley', sessionId: 'sess-2' })],
  });

  it('does NOT ship while a sibling is still executing (PR stays draft)', async () => {
    const f = build({ tickets: sharedTickets(), plansByTask: sharedPlans(), reviewVerdict: 'ok\nVERDICT: PASS' });
    await f.svc.integrate('T1', 7); // #8 still executing
    expect(f.markReadyForReview).not.toHaveBeenCalled();
    expect(f.transition).not.toHaveBeenCalledWith('T1', 7, 'self_review', { status: 'in_review' });
    // The draft PR is still opened so the owner sees it.
    expect(eventsOf(f.boardEmit, 'pr-opened').map((e) => e.taskId)).toEqual([7]);
  });

  it('the last sibling to publish ships: flips ALL siblings → in_review, runs the integration review, fans pr-ready', async () => {
    const tickets = sharedTickets();
    tickets[1].status = 'executing'; // #8 about to publish via integrate(8)
    const f = build({ tickets, plansByTask: sharedPlans(), reviewVerdict: 'ok\nVERDICT: PASS' });
    await f.svc.integrate('T1', 8); // transitions #8 → self_review, then all published → ship
    expect(f.markReadyForReview).toHaveBeenCalled();
    expect(f.engineRun).toHaveBeenCalledTimes(1); // the integration review (siblings>1)
    expect(f.updatePullRequest).toHaveBeenCalled(); // aggregated PR metadata
    expect(f.transition).toHaveBeenCalledWith('T1', 7, 'self_review', { status: 'in_review' });
    expect(f.transition).toHaveBeenCalledWith('T1', 8, 'self_review', { status: 'in_review' });
    expect(eventsOf(f.boardEmit, 'pr-ready').map((e) => e.taskId).sort()).toEqual([7, 8]);
  });

  it('flagged integration review still ships (advisory) and comments the findings on the PR + each sibling', async () => {
    const tickets = sharedTickets();
    tickets[1].status = 'executing';
    const f = build({
      tickets,
      plansByTask: sharedPlans(),
      reviewVerdict: 'Contract mismatch in X\nVERDICT: CHANGES',
    });
    await f.svc.integrate('T1', 8);
    expect(f.markReadyForReview).toHaveBeenCalled();
    expect(f.commentOnPullRequest).toHaveBeenCalledWith(
      'tok',
      expect.objectContaining({ body: expect.stringContaining('Contract mismatch in X') }),
    );
    // a findings note on each sibling (authored by the shipping ticket's reviewer/anchor — riley for #8)
    expect(f.noteAdd).toHaveBeenCalledWith('T1', 7, 'riley', expect.stringContaining('Contract mismatch'));
    expect(f.noteAdd).toHaveBeenCalledWith('T1', 8, 'riley', expect.stringContaining('Contract mismatch'));
  });
});

describe('ReviewPipelineService.integrate (gated mode)', () => {
  it('parks findings + seeds ONE owner to decide; never auto-ships', async () => {
    const f = build({ reviewVerdict: 'ok\nVERDICT: PASS', mode: 'gated' });
    await f.svc.integrate('T1', 7);
    expect(f.markReadyForReview).not.toHaveBeenCalled();
    expect(f.transition).not.toHaveBeenCalledWith('T1', 7, 'self_review', { status: 'in_review' });
    expect(f.noteAdd).toHaveBeenCalled();
    expect(eventsOf(f.boardEmit, 'self-review-ready').map((e) => e.employee)).toEqual(['alex']);
  });

  it('a failed findings write is a recoverable dead end → rolls back + narrates', async () => {
    const f = build({ reviewVerdict: 'ok\nVERDICT: PASS', mode: 'gated' });
    f.noteAdd.mockImplementationOnce(async () => {
      throw new Error('db down');
    });
    await f.svc.integrate('T1', 7);
    expect(f.transition).toHaveBeenCalledWith('T1', 7, 'self_review', { status: 'executing' });
    expect(eventsOf(f.boardEmit, 'self-review-failed').length).toBeGreaterThan(0);
    expect(eventsOf(f.boardEmit, 'self-review-ready')).toEqual([]);
  });
});

describe('ReviewPipelineService.shipSharedPr', () => {
  it('flips the PR ready + ticket → in_review + pr-ready (the path mark_pr_ready calls)', async () => {
    const f = build({ tickets: [{ id: 7, status: 'self_review', assignee: 'alex', project: 'proj', title: 'B', description: '' }] });
    const res = await f.svc.shipSharedPr('T1', 7);
    expect(res).toEqual({ ok: true });
    expect(f.markReadyForReview).toHaveBeenCalled();
    expect(f.transition).toHaveBeenCalledWith('T1', 7, 'self_review', { status: 'in_review' });
    expect(eventsOf(f.boardEmit, 'pr-ready').map((e) => e.taskId)).toEqual([7]);
  });

  it('returns {ok:false} (no board advance) when mark-ready fails', async () => {
    const f = build({
      tickets: [{ id: 7, status: 'self_review', assignee: 'alex', project: 'proj', title: 'B', description: '' }],
      markReadyThrows: true,
    });
    const res = await f.svc.shipSharedPr('T1', 7);
    expect(res.ok).toBe(false);
    expect(f.transition).not.toHaveBeenCalledWith('T1', 7, 'self_review', { status: 'in_review' });
  });
});
