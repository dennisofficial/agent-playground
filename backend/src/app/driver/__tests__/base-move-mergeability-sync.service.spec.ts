/**
 * Unit tests for `BaseMoveMergeabilitySync` — the batched GraphQL base-move refresh. All collaborators
 * (`StimulusIntake`, `CredentialResolver`, `GithubPrService`, the `repos`/`jobs` repos) are plain mocked
 * objects. No DB, no Docker. Uses fake timers to exercise the ~5s debounce.
 */

import type { Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GithubPrService } from '../../git';
import type { CredentialResolver } from '../../onboarding';
import type { JobEntity, RepoEntity } from '../../persistence/entities';
import type { StimulusIntake } from '../../stimulus';
import { BaseMoveMergeabilitySync } from '../base-move-mergeability-sync.service';

type MergeabilityResult = {
  number: number;
  mergeStateStatus: string;
  mergeableState: string;
  headSha: string | null;
};

function result(over: Partial<MergeabilityResult> = {}): MergeabilityResult {
  return {
    number: 7,
    mergeStateStatus: 'CLEAN',
    mergeableState: 'clean',
    headSha: 'abc',
    ...over,
  };
}

function make(over: {
  results?: MergeabilityResult[];
  job?: Partial<JobEntity> | null;
  repo?: Partial<RepoEntity> | null;
}) {
  const job =
    over.job === null
      ? null
      : ({
          id: 'job-1',
          org_id: 'T1',
          repo_id: 'repo-1',
          pr_number: 7,
          pr_mergeable: null,
          pr_url: 'http://pr/7',
          ...over.job,
        } as JobEntity);

  const intakeEvent = vi.fn(async () => ({
    admitted: true,
    stimulusId: 's1',
    jobId: 'job-1',
  }));
  const intake = { intakeEvent } as unknown as StimulusIntake;

  const creds = {
    githubToken: vi.fn(async () => 'tok'),
    hostGithubToken: vi.fn(async () => 'tok'),
  } as unknown as CredentialResolver;

  const listOpenPullMergeability = vi.fn(async () => over.results ?? [result()]);
  const pr = {
    listOpenPullMergeability,
    isGraphqlRateLimited: vi.fn(() => false),
  } as unknown as GithubPrService;

  const update = vi.fn(async () => ({}));
  const findOne = vi.fn(async () => job);
  const jobs = { update, findOne } as unknown as Repository<JobEntity>;

  const repos = {
    findOne: vi.fn(async () =>
      over.repo === null
        ? null
        : {
            git_url: 'https://github.com/o/r.git',
            default_branch: 'main',
            ...over.repo,
          },
    ),
  } as unknown as Repository<RepoEntity>;

  const sync = new BaseMoveMergeabilitySync(intake, creds, pr, repos, jobs);
  return {
    sync,
    intake,
    intakeEvent,
    creds,
    pr,
    jobs,
    update,
    findOne,
    listOpenPullMergeability,
    repos,
  };
}

describe('BaseMoveMergeabilitySync.schedule', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('collapses a burst of schedule() calls within the debounce window into ONE refresh', async () => {
    const { sync, listOpenPullMergeability } = make({ results: [result()] });

    sync.schedule('T1', 'repo-1');
    sync.schedule('T1', 'repo-1');
    sync.schedule('T1', 'repo-1');

    await vi.advanceTimersByTimeAsync(5_000);

    expect(listOpenPullMergeability).toHaveBeenCalledTimes(1);
  });
});

describe('BaseMoveMergeabilitySync.refresh (via schedule)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes pr_mergeable only on change', async () => {
    const { sync, update } = make({
      results: [result({ mergeableState: 'behind' })],
      job: { pr_mergeable: 'clean' },
    });
    sync.schedule('T1', 'repo-1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(update).toHaveBeenCalledWith({ id: 'job-1' }, { pr_mergeable: 'behind' });
  });

  it('does NOT write when pr_mergeable already matches', async () => {
    const { sync, update } = make({
      results: [result({ mergeableState: 'clean' })],
      job: { pr_mergeable: 'clean' },
    });
    sync.schedule('T1', 'repo-1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(update).not.toHaveBeenCalled();
  });

  it('routes a dirty result via intakeEvent with the conflict:<pr>:<sha> dedupe key', async () => {
    const { sync, intakeEvent } = make({
      results: [result({ mergeableState: 'dirty', headSha: 'sha123' })],
    });
    sync.schedule('T1', 'repo-1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(intakeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'T1',
        repoId: 'repo-1',
        source: 'github',
        dedupeKey: 'conflict:7:sha123',
        severity: 'critical',
        correlation: { prNumber: 7 },
      }),
    );
  });

  it('does NOT intake when the result is clean', async () => {
    const { sync, intakeEvent } = make({
      results: [result({ mergeableState: 'clean' })],
    });
    sync.schedule('T1', 'repo-1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(intakeEvent).not.toHaveBeenCalled();
  });

  it('no-ops (no listOpenPullMergeability call) when isGraphqlRateLimited()', async () => {
    const { sync, pr, listOpenPullMergeability } = make({
      results: [result()],
    });
    (pr.isGraphqlRateLimited as ReturnType<typeof vi.fn>).mockReturnValue(true);
    sync.schedule('T1', 'repo-1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listOpenPullMergeability).not.toHaveBeenCalled();
  });

  it('skips a PR with no owning job', async () => {
    const { sync, update, intakeEvent } = make({
      results: [result({ mergeableState: 'dirty', headSha: 'sha1' })],
      job: null,
    });
    sync.schedule('T1', 'repo-1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(update).not.toHaveBeenCalled();
    expect(intakeEvent).not.toHaveBeenCalled();
  });

  it('re-schedules once when a result is unknown (GitHub still computing)', async () => {
    const { sync, listOpenPullMergeability } = make({
      results: [result({ mergeableState: 'unknown', mergeStateStatus: 'UNKNOWN' })],
    });
    sync.schedule('T1', 'repo-1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listOpenPullMergeability).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(8_000);
    expect(listOpenPullMergeability).toHaveBeenCalledTimes(2);
  });

  it('writes unknown while GitHub is still computing so stale settled badges clear', async () => {
    const { sync, update } = make({
      results: [result({ mergeableState: 'unknown', mergeStateStatus: 'UNKNOWN' })],
      job: { pr_mergeable: 'clean' },
    });
    sync.schedule('T1', 'repo-1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(update).toHaveBeenCalledWith({ id: 'job-1' }, { pr_mergeable: 'unknown' });
  });

  it('caps unknown retries so a stuck repo does not retry forever', async () => {
    const { sync, listOpenPullMergeability } = make({
      results: [result({ mergeableState: 'unknown', mergeStateStatus: 'UNKNOWN' })],
    });
    sync.schedule('T1', 'repo-1');
    // Initial refresh + up to MAX_UNKNOWN_RETRIES (3) re-schedules = 4 calls total, then it stops.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(8_000);
    }
    expect(listOpenPullMergeability).toHaveBeenCalledTimes(4);
  });
});
