import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import type { CredentialResolver } from '../onboarding';
import { RateLimitedError } from '../git';
import type { GithubPrService, CheckRun, PullDetail } from '../git';
import type { StimulusIntake } from '../stimulus';
import type { JobEntity, RepoEntity } from '../persistence/entities';
import { CADENCE_MS, GitStateReconciler, sameCounts, summarizeChecks } from './git-state-reconciler.service';

// Fixed clock so the adaptive-cadence `next_poll_at` writes are deterministic (new Date(now + ms)).
const NOW = 1_700_000_000_000;

function make(over: {
  detail: PullDetail;
  runs?: CheckRun[];
  job?: Partial<JobEntity>;
  discovered?: { url: string; number: number } | null;
  affected?: number;
}) {
  const job = {
    id: 'job-1',
    org_id: 'T1',
    repo_id: 'repo-1',
    pr_number: 7,
    feature_branch: 'feat/a1b2c3d4',
    ci_status: null,
    ci_counts: null,
    pr_mergeable: null,
    ...over.job,
  } as JobEntity;
  const update = vi.fn(async () => ({ affected: over.affected ?? 1 }));
  const intakeEvent = vi.fn(async (_e?: unknown) => ({
    admitted: true,
    stimulusId: 's',
    jobId: job.id,
  }));
  const jobs = {
    find: vi.fn(async () => [job]),
    update,
  } as unknown as Repository<JobEntity>;
  const repos = {
    findOne: vi.fn(async () => ({
      git_url: 'https://github.com/acme/web.git',
    })),
  } as unknown as Repository<RepoEntity>;
  const findOpenPullByHead = vi.fn(async () => over.discovered ?? null);
  const pr = {
    getPullDetail: vi.fn(async () => over.detail),
    listCheckRuns: vi.fn(async () => over.runs ?? []),
    findOpenPullByHead,
    isRateLimited: vi.fn(() => false),
  } as unknown as GithubPrService;
  const creds = {
    githubToken: vi.fn(async () => 'tok'),
  } as unknown as CredentialResolver;
  const intake = { intakeEvent } as unknown as StimulusIntake;
  // Fire-and-forget re-evaluation on every reconcile — never asserted here, just must not throw (which
  // would otherwise be swallowed by `tick()`'s catch-all and silently default the cadence tier to `active`).
  const autoMerge = { maybeAutoMerge: vi.fn().mockResolvedValue(undefined) } as unknown as import('./auto-merge.service').AutoMergeService;
  const svc = new GitStateReconciler(jobs, repos, pr, creds, intake, autoMerge);
  return { svc, job, update, intakeEvent, pr, findOpenPullByHead, jobs };
}

function detail(over: Partial<PullDetail> = {}): PullDetail {
  return {
    number: 7,
    url: 'http://pr/7',
    state: 'open',
    mergeableState: 'clean',
    headSha: 'abc',
    headRef: 'feat/x',
    ...over,
  };
}

/** The single `next_poll_at` re-stamp write `tick()` issues per job after reconcileOne. */
function nextPollWrite(update: ReturnType<typeof vi.fn>): unknown {
  const call = update.mock.calls.find(
    (c) =>
      c[1] && typeof c[1] === 'object' && 'next_poll_at' in (c[1] as object),
  );
  return call?.[1];
}

describe('GitStateReconciler.tick', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('routes a merge conflict (dirty) to the owning job, updates columns, re-polls at the active cadence', async () => {
    const { svc, update, intakeEvent } = make({
      detail: detail({ mergeableState: 'dirty' }),
    });
    await svc.tick();
    expect(intakeEvent).toHaveBeenCalledOnce();
    expect(intakeEvent.mock.calls[0][0]).toMatchObject({
      source: 'github',
      dedupeKey: 'conflict:7:abc',
      severity: 'critical',
      correlation: { prNumber: 7 },
    });
    expect(update).toHaveBeenCalledWith(
      { id: 'job-1' },
      { ci_status: null, ci_counts: null, pr_mergeable: 'dirty' },
    );
    // dirty is a settled (non-null) state → active cadence, not the fast computing tier.
    expect(nextPollWrite(update)).toEqual({
      next_poll_at: new Date(NOW + CADENCE_MS.active),
    });
  });

  it('clean mergeable → no conflict routed, column refresh, active cadence', async () => {
    const { svc, intakeEvent, update } = make({
      detail: detail({ mergeableState: 'clean' }),
      runs: [
        {
          id: 1,
          name: 'CI',
          status: 'completed',
          conclusion: 'success',
          detailsUrl: null,
        },
      ],
    });
    await svc.tick();
    expect(intakeEvent).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      { id: 'job-1' },
      {
        ci_status: 'success',
        ci_counts: { failing: 0, pending: 0, passed: 1, skipped: 0, total: 1 },
        pr_mergeable: 'clean',
      },
    );
    expect(nextPollWrite(update)).toEqual({ next_poll_at: new Date(NOW + CADENCE_MS.active) });
  });

  it('null mergeable_state (GitHub still computing) → no conflict, re-polls at the FAST computing cadence', async () => {
    const { svc, intakeEvent, update } = make({
      detail: detail({ mergeableState: null }),
    });
    await svc.tick();
    expect(intakeEvent).not.toHaveBeenCalled();
    // The base-move-conflict window: poll every ~8s until GitHub resolves mergeability.
    expect(nextPollWrite(update)).toEqual({
      next_poll_at: new Date(NOW + CADENCE_MS.computing),
    });
  });

  it('unknown mergeable_state (GitHub still computing) → re-polls at the FAST computing cadence', async () => {
    const { svc, intakeEvent, update } = make({
      detail: detail({ mergeableState: 'unknown' }),
    });
    await svc.tick();
    expect(intakeEvent).not.toHaveBeenCalled();
    expect(nextPollWrite(update)).toEqual({
      next_poll_at: new Date(NOW + CADENCE_MS.computing),
    });
  });

  it('merged/closed PR → latches pr_state, CLEARS the poll clock (terminal), skips CI/conflict', async () => {
    const { svc, intakeEvent, update, pr } = make({
      detail: detail({ state: 'merged' }),
    });
    await svc.tick();
    expect(intakeEvent).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      { id: 'job-1' },
      { pr_state: 'merged' },
    );
    expect(pr.listCheckRuns).not.toHaveBeenCalled();
    // terminal → next_poll_at null so the job drops out of the DUE set (teardown owns it now).
    expect(nextPollWrite(update)).toEqual({ next_poll_at: null });
  });

  it('backfills pr_state=open for a legacy open-PR row with a null pr_state', async () => {
    const { svc, update } = make({
      detail: detail({ mergeableState: 'clean' }),
      job: { pr_state: null },
    });
    await svc.tick();
    expect(update).toHaveBeenCalledWith({ id: 'job-1' }, { pr_state: 'open' });
  });

  it('DISCOVERY: a branch-only job with an Atlas-opened PR → records pr_url/pr_number + flips done, active cadence', async () => {
    const { svc, update, findOpenPullByHead } = make({
      job: { pr_number: null, feature_branch: 'feat/a1b2c3d4' },
      discovered: { url: 'http://pr/9', number: 9 },
      detail: detail({ number: 9, mergeableState: 'clean' }),
    });
    await svc.tick();
    expect(findOpenPullByHead).toHaveBeenCalledWith('tok', {
      owner: 'acme',
      repo: 'web',
      head: 'feat/a1b2c3d4',
    });
    expect(update).toHaveBeenCalledWith(
      { id: 'job-1' },
      { pr_url: 'http://pr/9', pr_number: 9, status: 'done', pr_state: 'open' },
    );
    // A freshly discovered, settled PR polls at the active cadence (not the slow discovering tier).
    expect(nextPollWrite(update)).toEqual({
      next_poll_at: new Date(NOW + CADENCE_MS.active),
    });
  });

  it('DISCOVERY: branch-only job with no open PR yet → no column write, slow discovering cadence', async () => {
    const { svc, update, intakeEvent } = make({
      job: { pr_number: null, feature_branch: 'feat/a1b2c3d4' },
      discovered: null,
      detail: detail(),
    });
    await svc.tick();
    expect(intakeEvent).not.toHaveBeenCalled();
    // The ONLY write is the poll-clock re-stamp (no PR to observe yet) at the slow tier.
    expect(update.mock.calls).toHaveLength(1);
    expect(nextPollWrite(update)).toEqual({
      next_poll_at: new Date(NOW + CADENCE_MS.discovering),
    });
  });

  it('no column churn when nothing changed — only the poll-clock re-stamp is written', async () => {
    const { svc, update } = make({
      detail: detail({ mergeableState: 'clean' }),
      job: {
        ci_status: 'success',
        ci_counts: { failing: 0, pending: 0, passed: 1, skipped: 0, total: 1 },
        pr_mergeable: 'clean',
        pr_state: 'open',
      },
      runs: [{ id: 1, name: 'CI', status: 'completed', conclusion: 'success', detailsUrl: null }],
    });
    await svc.tick();
    expect(update.mock.calls).toHaveLength(1);
    expect(nextPollWrite(update)).toEqual({
      next_poll_at: new Date(NOW + CADENCE_MS.active),
    });
  });

  it('CLOBBER GUARD: empty check-runs never overwrite a known ci_status/ci_counts back to null', async () => {
    const { svc, update } = make({
      detail: detail({ mergeableState: 'clean' }),
      job: {
        ci_status: 'failure',
        ci_counts: { failing: 1, pending: 0, passed: 1, skipped: 0, total: 2 },
        pr_mergeable: 'clean',
        pr_state: 'open',
      },
      runs: [], // transient no-checks-yet window for this head SHA
    });
    await svc.tick();
    // Nothing changed (mergeableState unchanged, ci columns kept) — only the poll-clock re-stamp write.
    expect(update.mock.calls).toHaveLength(1);
    expect(nextPollWrite(update)).toEqual({ next_poll_at: new Date(NOW + CADENCE_MS.active) });
  });

  it('a throwing reconcile still re-stamps the clock (active) so the job backs off, not hammers', async () => {
    const { svc, update, pr } = make({ detail: detail() });
    (pr.getPullDetail as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('GitHub 500'),
    );
    const reconciled = await svc.tick();
    expect(reconciled).toBe(0); // the throwing job isn't counted
    expect(nextPollWrite(update)).toEqual({
      next_poll_at: new Date(NOW + CADENCE_MS.active),
    });
  });

  it('misconfig (no GitHub token) → backs off to the slow discovering cadence', async () => {
    const { svc, update } = make({ detail: detail() });
    // svc built with a token; override creds to none for this job.
    (svc as unknown as { creds: CredentialResolver }).creds = {
      githubToken: vi.fn(async () => null),
    } as unknown as CredentialResolver;
    await svc.tick();
    expect(nextPollWrite(update)).toEqual({
      next_poll_at: new Date(NOW + CADENCE_MS.discovering),
    });
  });

  it('rate-limited → skips the whole pass, no pr.* calls, no writes, returns 0', async () => {
    const { svc, update, pr } = make({ detail: detail() });
    (pr.isRateLimited as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const reconciled = await svc.tick();
    expect(reconciled).toBe(0);
    expect(pr.getPullDetail).not.toHaveBeenCalled();
    expect(pr.listCheckRuns).not.toHaveBeenCalled();
    expect(pr.findOpenPullByHead).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('a RateLimitedError mid-pass leaves the tripping job DUE — no next_poll_at re-stamp', async () => {
    const { svc, update, pr } = make({ detail: detail() });
    (pr.getPullDetail as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new RateLimitedError('paused'),
    );
    (pr.isRateLimited as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const reconciled = await svc.tick();
    expect(reconciled).toBe(0);
    expect(nextPollWrite(update)).toBeUndefined();
  });
});

describe('GitStateReconciler.markRepoDue', () => {
  it('marks every OPEN PR on the repo due-now (next_poll_at = now) and returns the affected count', async () => {
    const { svc, update } = make({ detail: detail(), affected: 3 });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const marked = await svc.markRepoDue('T1', 'repo-1');
    expect(marked).toBe(3);
    expect(update).toHaveBeenCalledWith(
      { org_id: 'T1', repo_id: 'repo-1', pr_state: 'open' },
      { next_poll_at: new Date(NOW) },
    );
    vi.useRealTimers();
  });

  it('returns 0 when the repo has no open PRs', async () => {
    const { svc } = make({ detail: detail(), affected: 0 });
    expect(await svc.markRepoDue('T1', 'repo-1')).toBe(0);
  });
});

describe('GitStateReconciler.markJobDue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('by prNumber: targets org_id/repo_id/pr_number and stamps next_poll_at = now', async () => {
    const { svc, update } = make({ detail: detail(), affected: 1 });
    const marked = await svc.markJobDue('T1', 'repo-1', { prNumber: 7 });
    expect(marked).toBe(1);
    expect(update).toHaveBeenCalledWith(
      { org_id: 'T1', repo_id: 'repo-1', pr_number: 7 },
      { next_poll_at: new Date(NOW) },
    );
  });

  it('by branch (no prNumber): targets org_id/repo_id/feature_branch', async () => {
    const { svc, update } = make({ detail: detail(), affected: 1 });
    const marked = await svc.markJobDue('T1', 'repo-1', {
      branch: 'feat/a1b2c3d4',
    });
    expect(marked).toBe(1);
    expect(update).toHaveBeenCalledWith(
      { org_id: 'T1', repo_id: 'repo-1', feature_branch: 'feat/a1b2c3d4' },
      { next_poll_at: new Date(NOW) },
    );
  });

  it('falls back to branch when prNumber marks no job', async () => {
    const { svc, update } = make({ detail: detail(), affected: 0 });
    update
      .mockResolvedValueOnce({ affected: 0 })
      .mockResolvedValueOnce({ affected: 1 });
    const marked = await svc.markJobDue('T1', 'repo-1', {
      prNumber: 7,
      branch: 'feat/a1b2c3d4',
    });
    expect(marked).toBe(1);
    expect(update).toHaveBeenNthCalledWith(
      1,
      { org_id: 'T1', repo_id: 'repo-1', pr_number: 7 },
      { next_poll_at: new Date(NOW) },
    );
    expect(update).toHaveBeenNthCalledWith(
      2,
      { org_id: 'T1', repo_id: 'repo-1', feature_branch: 'feat/a1b2c3d4' },
      { next_poll_at: new Date(NOW) },
    );
  });

  it('neither prNumber nor branch → returns 0, no update', async () => {
    const { svc, update } = make({ detail: detail() });
    expect(await svc.markJobDue('T1', 'repo-1', {})).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('summarizeChecks', () => {
  const run = (conclusion: string | null, status = 'completed'): CheckRun => ({ id: 1, name: 'x', status, conclusion, detailsUrl: null });

  it('{ status: null, counts: null } when no checks', () =>
    expect(summarizeChecks([])).toEqual({ status: null, counts: null }));

  it('THE EXACT REPRO: 2 failing + 1 skipped + 3 success → failure, with per-category counts', () => {
    const runs = [
      run('failure'), run('failure'),
      run('skipped'),
      run('success'), run('success'), run('success'),
    ];
    expect(summarizeChecks(runs)).toEqual({
      status: 'failure',
      counts: { failing: 2, pending: 0, passed: 3, skipped: 1, total: 6 },
    });
  });

  it('all skipped/neutral (no success, no failure) → status skipped', () => {
    const result = summarizeChecks([run('skipped'), run('neutral')]);
    expect(result.status).toBe('skipped');
    expect(result.counts?.skipped).toBe(2);
  });

  it('mixed success + skipped (none failing) → status success', () => {
    const result = summarizeChecks([run('success'), run('neutral')]);
    expect(result.status).toBe('success');
    expect(result.counts?.skipped).toBeGreaterThan(0);
  });

  it('failing + in_progress → failure (failure takes precedence over pending)', () => {
    expect(summarizeChecks([run('failure'), run(null, 'in_progress')]).status).toBe('failure');
  });

  it('success + in_progress → pending', () => {
    expect(summarizeChecks([run('success'), run(null, 'in_progress')]).status).toBe('pending');
  });
});

describe('sameCounts', () => {
  it('treats null/null as equal and null/non-null as unequal', () => {
    expect(sameCounts(null, null)).toBe(true);
    expect(sameCounts(null, { failing: 0, pending: 0, passed: 1, skipped: 0, total: 1 })).toBe(false);
  });
  it('compares each category', () => {
    const a = { failing: 1, pending: 0, passed: 2, skipped: 0, total: 3 };
    const b = { failing: 1, pending: 0, passed: 2, skipped: 0, total: 3 };
    const c = { failing: 0, pending: 0, passed: 2, skipped: 1, total: 3 };
    expect(sameCounts(a, b)).toBe(true);
    expect(sameCounts(a, c)).toBe(false);
  });
});
