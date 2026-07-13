/**
 * Unit tests for `GithubCiStateSync` — the silent GitHub CI-status webhook fast path. All collaborators
 * (`StimulusStoreService`, `CredentialResolver`, `GithubPrService`, the `repos`/`jobs` repos) are plain
 * mocked objects. No DB, no Docker. Uses fake timers to exercise the ~5s debounce.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import type { CredentialResolver } from '../onboarding';
import type { GithubPrService, PullDetail } from '../git';
import type { StimulusStoreService } from '../stimulus';
import type { CiSyncDelta } from '../domain';
import type { JobEntity, RepoEntity } from '../persistence/entities';
import { GithubCiStateSync } from './github-ci-state-sync.service';

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

function make(over: {
  detail?: PullDetail;
  runs?: Array<{
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    detailsUrl: string | null;
  }>;
  job?: Partial<JobEntity> | null;
  discovered?: { url: string; number: number } | null;
}) {
  const job =
    over.job === null
      ? null
      : ({
          id: 'job-1',
          org_id: 'T1',
          repo_id: 'repo-1',
          pr_number: 7,
          ci_status: null,
          ci_counts: null,
          ...over.job,
        } as JobEntity);

  const findOwningJobByPrNumber = vi.fn(async () => job);
  const findOwningJobByBranch = vi.fn(async () => job);
  const stimStore = {
    findOwningJobByPrNumber,
    findOwningJobByBranch,
  } as unknown as StimulusStoreService;

  const creds = {
    githubToken: vi.fn(async () => 'tok'),
  } as unknown as CredentialResolver;

  const findOpenPullByHead = vi.fn(async () => over.discovered ?? null);
  const getPullDetail = vi.fn(async () => over.detail ?? detail());
  const listCheckRuns = vi.fn(async () => over.runs ?? []);
  const pr = {
    findOpenPullByHead,
    getPullDetail,
    listCheckRuns,
    isRateLimited: vi.fn(() => false),
  } as unknown as GithubPrService;

  const update = vi.fn(async () => ({}));
  const jobs = { update } as unknown as Repository<JobEntity>;
  const repos = {
    findOne: vi.fn(async () => ({ git_url: 'https://github.com/o/r.git' })),
  } as unknown as Repository<RepoEntity>;

  // Fire-and-forget re-evaluation on every recompute — never asserted here, just must not throw.
  const autoMerge = { maybeAutoMerge: vi.fn().mockResolvedValue(undefined) } as unknown as import('./auto-merge.service').AutoMergeService;
  const sync = new GithubCiStateSync(stimStore, creds, pr, repos, jobs, autoMerge);
  return {
    sync,
    stimStore,
    creds,
    pr,
    jobs,
    update,
    findOwningJobByPrNumber,
    findOwningJobByBranch,
    findOpenPullByHead,
    getPullDetail,
    listCheckRuns,
  };
}

const DELTA: CiSyncDelta = {
  orgId: 'T1',
  repoId: 'repo-1',
  prNumber: 7,
  branch: 'feat/x',
};

describe('GithubCiStateSync.schedule', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('collapses a burst of schedule() calls within the debounce window into ONE recompute', async () => {
    const { sync, getPullDetail } = make({ detail: detail() });

    sync.schedule(DELTA);
    sync.schedule(DELTA);
    sync.schedule(DELTA);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(getPullDetail).toHaveBeenCalledTimes(1);
  });
});

describe('GithubCiStateSync recompute (via schedule)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const run = (conclusion: string | null, status = 'completed') => ({
    id: 1,
    name: 'x',
    status,
    conclusion,
    detailsUrl: null,
  });

  it('writes ci_status=success against the getPullDetail head SHA (not any webhook SHA)', async () => {
    const { sync, update, pr, getPullDetail } = make({
      detail: detail({ headSha: 'current-head-sha' }),
      runs: [run('success')],
    });

    sync.schedule(DELTA);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(getPullDetail).toHaveBeenCalled();
    expect(pr.listCheckRuns).toHaveBeenCalledWith('tok', {
      owner: 'o',
      repo: 'r',
      ref: 'current-head-sha',
    });
    expect(update).toHaveBeenCalledWith(
      { id: 'job-1' },
      {
        ci_status: 'success',
        ci_counts: { failing: 0, pending: 0, passed: 1, skipped: 0, total: 1 },
        pr_mergeable: 'clean',
      },
    );
  });

  it('writes ci_status=failure with per-category counts (2 failing, 1 skipped, 3 success)', async () => {
    const { sync, update } = make({
      detail: detail(),
      runs: [run('failure'), run('failure'), run('skipped'), run('success'), run('success'), run('success')],
    });
    sync.schedule(DELTA);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(update).toHaveBeenCalledWith(
      { id: 'job-1' },
      {
        ci_status: 'failure',
        ci_counts: { failing: 2, pending: 0, passed: 3, skipped: 1, total: 6 },
        pr_mergeable: 'clean',
      },
    );
  });

  it('writes ci_status=pending when a run is still running', async () => {
    const { sync, update } = make({
      detail: detail(),
      runs: [run('success'), run(null, 'in_progress')],
    });
    sync.schedule(DELTA);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(update).toHaveBeenCalledWith(
      { id: 'job-1' },
      {
        ci_status: 'pending',
        ci_counts: { failing: 0, pending: 1, passed: 1, skipped: 0, total: 2 },
        pr_mergeable: 'clean',
      },
    );
  });

  it('CLOBBER GUARD: empty check-runs never overwrite a known ci_status/ci_counts back to null', async () => {
    const { sync, update } = make({
      detail: detail(),
      runs: [],
      job: {
        ci_status: 'failure',
        ci_counts: { failing: 1, pending: 0, passed: 1, skipped: 0, total: 2 },
      },
    });
    sync.schedule(DELTA);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(update).not.toHaveBeenCalled();
  });

  it('does NOT write when the computed ci matches the job already has', async () => {
    const { sync, update } = make({
      detail: detail(),
      runs: [run('success')],
      job: {
        ci_status: 'success',
        ci_counts: { failing: 0, pending: 0, passed: 1, skipped: 0, total: 1 },
        pr_mergeable: 'clean',
      },
    });
    sync.schedule(DELTA);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(update).not.toHaveBeenCalled();
  });

  it('no-op when no owning job (branch and PR lookups both null)', async () => {
    const { sync, update, pr } = make({ detail: detail(), job: null });
    sync.schedule(DELTA);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(update).not.toHaveBeenCalled();
    expect(pr.getPullDetail).not.toHaveBeenCalled();
  });

  it('no-op when the PR is not open (merged/closed)', async () => {
    const { sync, update } = make({ detail: detail({ state: 'merged' }) });
    sync.schedule(DELTA);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(update).not.toHaveBeenCalled();
  });

  it('branch fallback: job with pr_number null resolves the PR via findOpenPullByHead then recomputes', async () => {
    const { sync, update, findOpenPullByHead, getPullDetail } = make({
      job: { pr_number: null },
      discovered: { url: 'http://pr/9', number: 9 },
      detail: detail({ number: 9 }),
      runs: [run('success')],
    });

    sync.schedule({
      orgId: 'T1',
      repoId: 'repo-1',
      prNumber: null,
      branch: 'feat/x',
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(findOpenPullByHead).toHaveBeenCalledWith('tok', {
      owner: 'o',
      repo: 'r',
      head: 'feat/x',
    });
    expect(getPullDetail).toHaveBeenCalledWith('tok', {
      owner: 'o',
      repo: 'r',
      number: 9,
    });
    expect(update).toHaveBeenCalledWith(
      { id: 'job-1' },
      {
        ci_status: 'success',
        ci_counts: { failing: 0, pending: 0, passed: 1, skipped: 0, total: 1 },
        pr_mergeable: 'clean',
      },
    );
  });

  it('no-op (no getPullDetail, no update) when rate-limited', async () => {
    const { sync, update, pr, getPullDetail } = make({ detail: detail(), runs: [run('success')] });
    (pr.isRateLimited as ReturnType<typeof vi.fn>).mockReturnValue(true);
    sync.schedule(DELTA);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getPullDetail).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('writes both columns when only pr_mergeable changed (ci unchanged)', async () => {
    const { sync, update } = make({
      detail: detail({ mergeableState: 'dirty' }),
      runs: [run('success')],
      job: {
        ci_status: 'success',
        ci_counts: { failing: 0, pending: 0, passed: 1, skipped: 0, total: 1 },
        pr_mergeable: 'clean',
      },
    });
    sync.schedule(DELTA);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(update).toHaveBeenCalledWith(
      { id: 'job-1' },
      {
        ci_status: 'success',
        ci_counts: { failing: 0, pending: 0, passed: 1, skipped: 0, total: 1 },
        pr_mergeable: 'dirty',
      },
    );
  });
});
