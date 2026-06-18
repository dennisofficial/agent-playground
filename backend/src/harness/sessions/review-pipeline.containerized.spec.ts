import { describe, expect, it, vi } from 'vitest';
import { ReviewPipelineService } from './review-pipeline.service';
import type { Session } from './session-registry.port';

/**
 * Phase 11 — the CONTAINERIZED branch of ReviewPipelineService's review + ship paths. With a sandbox
 * session (the provider's `isContainerized` true, `daemonFor` yielding a daemon double), the service must:
 *  - get the review SCOPE from the daemon (`reviewRange`), NOT the host `WorkspaceService` row / the
 *    host-only `projectRecordFor` (the host has no tree);
 *  - ship via the daemon (`openPr`/`markReady`/`commentPr`), NOT the host GithubApiService;
 *  - never read a host `workspace.path` / `workspace.sharedBranch` (there is no host row).
 *
 * These exercise the dormant remote branch with fakes (no live Redis/Docker). The LOCAL byte-identical
 * behavior is covered by review-pipeline.service.spec.ts + review-pipeline.full-impl-review.spec.ts.
 */

const SANDBOX = 'sandbox-uuid-1';

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    task: 'Build the thing',
    workspaceId: SANDBOX,
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

function build(opts: { reviewVerdict?: string; findings?: string } = {}) {
  // The daemon double — the OFF-PORT ops the containerized branch reaches via daemonFor.
  const reviewRange = vi.fn(async () => ({
    range: 'cut...agent/sess-1',
    files: ['a.ts'],
    baseBranch: 'main',
  }));
  const openPr = vi.fn(async () => ({
    url: 'https://github.com/o/r/pull/9',
    number: 9,
    existing: false,
  }));
  const markReady = vi.fn(async () => ({ isDraft: false }));
  const commentPr = vi.fn(async () => undefined);
  const daemon = { reviewRange, openPr, markReady, commentPr };

  // The PORT-surface ops still route through resolve() — for a containerized run they'd be the daemon
  // adapter; here a single stub stands in for both (publish/sharedRef/ensureSharedAtBase succeed).
  const publish = vi.fn(async () => ({ integrated: true, sharedBranch: 'shared/feat' }));
  const port = {
    sharedRef: vi.fn(async () => 'sharedsha'),
    ensureSharedAtBase: vi.fn(async () => ({ ok: true, sharedBranch: 'shared/feat' })),
    ownerDiff: vi.fn(async () => ({ range: 'cut...agent/sess-1', files: ['a.ts'] })),
    publish,
    // projectRecordFor must NEVER be called on the containerized path — make it explode if it is.
    projectRecordFor: vi.fn(async () => {
      throw new Error('projectRecordFor must not be called on the containerized path');
    }),
  };
  const workspaceGit = {
    isContainerized: () => true,
    daemonFor: () => daemon,
    resolve: () => port,
  } as never;

  const engineRun = vi.fn(async () => ({
    result: opts.reviewVerdict ?? 'Looks good.\nVERDICT: PASS',
  }));
  const turnExecutor = { run: () => engineRun() } as never;

  const reviewSpecCap = { name: 'self_review', spec: () => ({ engine: 'codex', systemPrompt: 'sp' }) };
  const bot = {
    id: 'alex',
    capabilities: () => [reviewSpecCap],
    executeEngine: () => ({ engine: 'claude', systemPrompt: 'sp' }),
  };
  const employees = {
    byId: () => bot,
    teamLead: () => bot,
    context: () => ({}),
  } as never;

  const credCtx = { run: (_c: unknown, fn: () => unknown) => fn() } as never;
  const creds = { resolve: async () => ({ anthropic: 'k', openai: 'k' }) } as never;
  // The host WorkspaceService — `get` returns undefined for a sandbox (no host row). The containerized
  // branch must NOT early-return on that.
  const workspaces = { get: () => undefined } as never;
  const tokens = { resolve: async () => undefined } as never;
  // The host GithubApiService must never be touched on the containerized ship.
  const hostOpenPullRequest = vi.fn(async () => {
    throw new Error('host github must not be called on the containerized path');
  });
  const github = {
    openPullRequest: hostOpenPullRequest,
    markReadyForReview: vi.fn(),
    commentOnPullRequest: vi.fn(),
    listOpenPullRequests: vi.fn(),
    updatePullRequest: vi.fn(),
  } as never;
  const task = {
    id: 7,
    status: 'executing',
    assignee: 'alex',
    project: 'proj',
    title: 'Build',
    description: 'desc',
  };
  const board = {
    get: async () => task,
    update: vi.fn(async () => undefined),
    transition: vi.fn(async () => undefined),
  } as never;
  const plans = {
    setPrUrl: vi.fn(async () => undefined),
    listForTask: async () => [],
    setExecuteContext: vi.fn(async () => undefined),
    setOwnerStatus: vi.fn(async () => undefined),
  } as never;
  const notes = { add: vi.fn(async () => ({ id: 1 })) } as never;
  const boardEvents = { emit: vi.fn() } as never;
  const runner = { resumeInternal: vi.fn(async () => makeSession()) } as never;
  const sessions = { get: async (sid: string) => makeSession({ id: sid }) } as never;
  const env = { get: () => 'advisory' } as never;

  const svc = new ReviewPipelineService(
    turnExecutor,
    employees,
    credCtx,
    creds,
    workspaces,
    workspaceGit,
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
  return { svc, daemon, reviewRange, openPr, markReady, commentPr, hostOpenPullRequest, port };
}

describe('ReviewPipelineService — containerized routing (host has NO git)', () => {
  it('reviewFullImplementation gets the range from the daemon (never projectRecordFor / host row)', async () => {
    const f = build({ reviewVerdict: 'seams ok\nVERDICT: PASS' });
    const out = await f.svc.reviewFullImplementation({
      team: 'T1',
      taskId: 7,
      workspaceId: SANDBOX,
      session: makeSession(),
    });
    expect(out.verdict).toBe('pass');
    expect(f.reviewRange).toHaveBeenCalledTimes(1);
    expect(f.port.projectRecordFor).not.toHaveBeenCalled();
  });

  it('reviewFullImplementation degrades to a clean pass when the daemon range is empty', async () => {
    const f = build();
    f.daemon.reviewRange.mockResolvedValueOnce({ range: '', files: [], baseBranch: 'main' });
    const out = await f.svc.reviewFullImplementation({
      team: 'T1',
      taskId: 7,
      workspaceId: SANDBOX,
      session: makeSession(),
    });
    expect(out).toEqual({ verdict: 'pass', findings: '' });
  });

  it('shipTask opens the PR via the daemon (openPr + markReady), never the host github', async () => {
    const f = build();
    const res = await f.svc.shipTask({
      team: 'T1',
      taskId: 7,
      workspaceId: SANDBOX,
      session: makeSession(),
      findings: 'advisory finding',
    });
    expect(res.ok).toBe(true);
    expect(res.prUrl).toBe('https://github.com/o/r/pull/9');
    expect(f.openPr).toHaveBeenCalledWith({
      title: 'Build',
      body: 'desc',
      draft: false,
    });
    expect(f.markReady).toHaveBeenCalledWith(9);
    // Advisory findings ride a daemon PR comment (the daemon owns the repo/token).
    expect(f.commentPr).toHaveBeenCalledWith(9, expect.stringContaining('advisory finding'));
    // The host github client is NEVER touched on the containerized ship.
    expect(f.hostOpenPullRequest).not.toHaveBeenCalled();
    expect(f.port.projectRecordFor).not.toHaveBeenCalled();
  });

  it('reviewStage runs the containerized review + publish without a host workspace row', async () => {
    const f = build({ reviewVerdict: 'ok\nVERDICT: PASS' });
    const out = await f.svc.reviewStage(makeSession());
    // A clean pass + publish completes — proving the host-row guards did NOT block the sandbox session.
    expect(out).toEqual({ kind: 'complete' });
    expect(f.port.publish).toHaveBeenCalled();
  });
});
