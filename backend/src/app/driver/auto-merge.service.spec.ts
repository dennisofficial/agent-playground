/**
 * Unit tests for `AutoMergeService` — the merge-ready evaluator + the ONE resolution path (`mergeNow`)
 * both the auto path and a manual "Merge PR" click land on. All collaborators (repos, `GithubPrService`,
 * `CredentialResolver`, `JobLifecycleService`, `TurnRegistry`, `StimulusStoreService`,
 * `DriverStoreService`) are plain mocked objects. No DB, no Nest module boot.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import type { GithubPrService, PullDetail } from '../git';
import type { CredentialResolver } from '../onboarding';
import type { JobLifecycleService } from './job-lifecycle.service';
import type { TurnRegistry } from '../sandbox/turn-registry.service';
import type { StimulusStoreService } from '../stimulus/stimulus-store.service';
import type { DriverStoreService } from './driver-store.service';
import type {
  JobEntity,
  RepoEntity,
  MessageEntity,
} from '../persistence/entities';
import { AutoMergeService, prMergeReady } from './auto-merge.service';

function makeJobEntity(over: Partial<JobEntity> = {}): JobEntity {
  return {
    id: 'job-1',
    org_id: 'T1',
    repo_id: 'repo-1',
    activity: 'idle',
    halted: false,
    halt: null,
    open_question_count: 0,
    awaiting_secret_id: null,
    pr_state: 'open',
    pr_number: 7,
    pr_mergeable: 'clean',
    ci_status: 'success',
    auto_merge: false,
    auto_merge_by: null,
    feature_branch: 'atlas/feature',
    ...over,
  } as JobEntity;
}

function make(
  over: {
    job?: JobEntity;
    repo?: Partial<RepoEntity>;
    mergeResult?: unknown;
    existingMethodNote?: Partial<MessageEntity> | null;
  } = {},
) {
  const job = over.job ?? makeJobEntity();

  const findOneBy = vi.fn(async () => job);
  const jobs = { findOneBy } as unknown as Repository<JobEntity>;

  const repo = {
    id: 'repo-1',
    git_url: 'https://github.com/acme/app.git',
    default_auto_merge_method: 'squash',
    default_auto_merge_delete_branch: true,
    ...over.repo,
  } as RepoEntity;
  const repoFindOne = vi.fn(async () => repo);
  const repos = { findOne: repoFindOne } as unknown as Repository<RepoEntity>;

  const messagesFindOne = vi.fn(async () => over.existingMethodNote ?? null);
  const messagesSave = vi.fn(async (row: unknown) => row);
  const messagesCreate = vi.fn((row: unknown) => row as MessageEntity);
  const messages = {
    findOne: messagesFindOne,
    save: messagesSave,
    create: messagesCreate,
  } as unknown as Repository<MessageEntity>;

  const getPullDetail = vi.fn(async (): Promise<PullDetail> => ({
    number: 7,
    url: 'https://github.com/acme/app/pull/7',
    state: 'open' as const,
    mergeableState: 'clean',
    headSha: 'HEAD',
    headRef: 'atlas/feature',
  }));
  const mergePullRequest = vi.fn(
    async () => over.mergeResult ?? { ok: true, sha: 'merged-sha' },
  );
  const deleteBranch = vi.fn(async () => undefined);
  const pr = {
    getPullDetail,
    mergePullRequest,
    deleteBranch,
  } as unknown as GithubPrService;

  const githubToken = vi.fn(async () => 'ghp_tok');
  const creds = { githubToken } as unknown as CredentialResolver;

  const applyGithubPrState = vi.fn(async () => 'closed' as const);
  const lifecycle = { applyGithubPrState } as unknown as JobLifecycleService;

  const runningBrainTurn = vi.fn(async () => null);
  const turns = { runningBrainTurn } as unknown as TurnRegistry;

  const hasUndeliveredChat = vi.fn(async () => false);
  const stimulusStore = {
    hasUndeliveredChat,
  } as unknown as StimulusStoreService;

  const postMergeCard = vi.fn(async () => undefined);
  const neutralizeMergeCard = vi.fn(async () => undefined);
  const ownerUserId = vi.fn(async () => 'owner-1');
  const driverStore = {
    postMergeCard,
    neutralizeMergeCard,
    ownerUserId,
  } as unknown as DriverStoreService;

  const svc = new AutoMergeService(
    jobs,
    repos,
    messages,
    pr,
    creds,
    lifecycle,
    turns,
    stimulusStore,
    driverStore,
  );

  return {
    svc,
    job,
    repo,
    findOneBy,
    repoFindOne,
    messagesFindOne,
    messagesSave,
    getPullDetail,
    mergePullRequest,
    deleteBranch,
    githubToken,
    applyGithubPrState,
    runningBrainTurn,
    hasUndeliveredChat,
    postMergeCard,
    neutralizeMergeCard,
    ownerUserId,
  };
}

describe('prMergeReady', () => {
  const base = {
    pr_state: 'open',
    pr_number: 7,
    pr_mergeable: 'clean',
    ci_status: 'success',
  };

  it('is true for clean + success', () => {
    expect(prMergeReady(base)).toBe(true);
  });

  it('is true for clean + skipped', () => {
    expect(prMergeReady({ ...base, ci_status: 'skipped' })).toBe(true);
  });

  it('is true for clean + null ci (no checks reported)', () => {
    expect(prMergeReady({ ...base, ci_status: null })).toBe(true);
  });

  it('is false for clean + failure', () => {
    expect(prMergeReady({ ...base, ci_status: 'failure' })).toBe(false);
  });

  it('is false for clean + pending', () => {
    expect(prMergeReady({ ...base, ci_status: 'pending' })).toBe(false);
  });

  it.each(['dirty', 'behind', 'blocked'])(
    'is false for pr_mergeable %s',
    (state) => {
      expect(prMergeReady({ ...base, pr_mergeable: state })).toBe(false);
    },
  );

  it.each(['merged', 'closed'])('is false for pr_state %s', (state) => {
    expect(prMergeReady({ ...base, pr_state: state })).toBe(false);
  });

  it('is false when pr_number is null', () => {
    expect(prMergeReady({ ...base, pr_number: null })).toBe(false);
  });
});

describe('AutoMergeService.brainSettled (private, cast to any)', () => {
  it('is true when idle, all-clear, no running turn, no undelivered chat', async () => {
    const { svc, job } = make();
    await expect((svc as any).brainSettled(job)).resolves.toBe(true);
  });

  it('is false when activity is not idle', async () => {
    const { svc, job } = make({ job: makeJobEntity({ activity: 'build' }) });
    await expect((svc as any).brainSettled(job)).resolves.toBe(false);
  });

  it('is false when halted', async () => {
    const { svc, job } = make({ job: makeJobEntity({ halted: true }) });
    await expect((svc as any).brainSettled(job)).resolves.toBe(false);
  });

  it('is false when halt is non-null', async () => {
    const { svc, job } = make({
      job: makeJobEntity({
        halt: { kind: 'failed', reason: 'x', at: new Date().toISOString() },
      }),
    });
    await expect((svc as any).brainSettled(job)).resolves.toBe(false);
  });

  it('is false when open_question_count > 0', async () => {
    const { svc, job } = make({
      job: makeJobEntity({ open_question_count: 1 }),
    });
    await expect((svc as any).brainSettled(job)).resolves.toBe(false);
  });

  it('is false when awaiting_secret_id is set', async () => {
    const { svc, job } = make({
      job: makeJobEntity({ awaiting_secret_id: 'secret-1' }),
    });
    await expect((svc as any).brainSettled(job)).resolves.toBe(false);
  });

  it('is false when runningBrainTurn returns non-null', async () => {
    const { svc, job, runningBrainTurn } = make();
    (runningBrainTurn as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'turn-1',
    });
    await expect((svc as any).brainSettled(job)).resolves.toBe(false);
  });

  it('is false when hasUndeliveredChat is true', async () => {
    const { svc, job, hasUndeliveredChat } = make();
    (hasUndeliveredChat as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    await expect((svc as any).brainSettled(job)).resolves.toBe(false);
  });
});

describe('AutoMergeService.mergeNow', () => {
  it('merges, deletes the branch (when configured + a feature branch exists), applies pr_state=merged, neutralizes the card, and returns true', async () => {
    const {
      svc,
      job,
      applyGithubPrState,
      deleteBranch,
      neutralizeMergeCard,
      mergePullRequest,
    } = make();
    const ok = await svc.mergeNow(job.id, 'user-1');
    expect(ok).toBe(true);
    expect(mergePullRequest).toHaveBeenCalledWith(
      'ghp_tok',
      expect.objectContaining({
        owner: 'acme',
        repo: 'app',
        number: 7,
        method: 'squash',
        sha: 'HEAD',
      }),
    );
    expect(applyGithubPrState).toHaveBeenCalledWith(job, 'merged');
    expect(deleteBranch).toHaveBeenCalledWith('ghp_tok', {
      owner: 'acme',
      repo: 'app',
      branch: 'atlas/feature',
    });
    expect(neutralizeMergeCard).toHaveBeenCalledWith(job.id);
  });

  it('does NOT delete the branch when the repo default_auto_merge_delete_branch is false', async () => {
    const { svc, job, deleteBranch } = make({
      repo: { default_auto_merge_delete_branch: false },
    });
    await svc.mergeNow(job.id, 'user-1');
    expect(deleteBranch).not.toHaveBeenCalled();
  });

  it('does NOT delete the branch when there is no feature branch', async () => {
    const { svc, job, getPullDetail, deleteBranch } = make({
      job: makeJobEntity({ feature_branch: null }),
    });
    getPullDetail.mockResolvedValueOnce({
      number: 7,
      url: 'https://github.com/acme/app/pull/7',
      state: 'open',
      mergeableState: 'clean',
      headSha: 'HEAD',
      headRef: null,
    });
    await svc.mergeNow(job.id, 'user-1');
    expect(deleteBranch).not.toHaveBeenCalled();
  });

  it('deletes the PR head ref returned by GitHub when it differs from the canonical feature_branch', async () => {
    const { svc, job, getPullDetail, deleteBranch } = make({
      job: makeJobEntity({ feature_branch: 'atlas/canonical' }),
    });
    getPullDetail.mockResolvedValueOnce({
      number: 7,
      url: 'https://github.com/acme/app/pull/7',
      state: 'open',
      mergeableState: 'clean',
      headSha: 'HEAD',
      headRef: 'atlas/live-branch',
    });
    await svc.mergeNow(job.id, 'user-1');
    expect(deleteBranch).toHaveBeenCalledWith('ghp_tok', {
      owner: 'acme',
      repo: 'app',
      branch: 'atlas/live-branch',
    });
  });

  it('already_merged is treated as a success (idempotent): still applies pr_state=merged and returns true', async () => {
    const { svc, job, applyGithubPrState } = make({
      mergeResult: {
        ok: false,
        reason: 'already_merged',
        status: 405,
        message: 'already merged',
      },
    });
    const ok = await svc.mergeNow(job.id, 'user-1');
    expect(ok).toBe(true);
    expect(applyGithubPrState).toHaveBeenCalledWith(job, 'merged');
  });

  it.each(['not_mergeable', 'sha_mismatch'] as const)(
    'returns false, does NOT apply pr_state and does NOT touch messages on a %s rejection (no brain seed)',
    async (reason) => {
      const { svc, job, applyGithubPrState, messagesSave } = make({
        mergeResult: {
          ok: false,
          reason,
          status: reason === 'sha_mismatch' ? 409 : 405,
          message: 'x',
        },
      });
      const ok = await svc.mergeNow(job.id, 'user-1');
      expect(ok).toBe(false);
      expect(applyGithubPrState).not.toHaveBeenCalled();
      expect(messagesSave).not.toHaveBeenCalled();
    },
  );

  it('posts a one-time operator note on method_disallowed, does not apply pr_state, and dedupes a repeat', async () => {
    const { svc, job, messagesSave, applyGithubPrState } = make({
      mergeResult: {
        ok: false,
        reason: 'method_disallowed',
        status: 422,
        message: 'squash not allowed',
      },
    });
    const ok = await svc.mergeNow(job.id, 'user-1');
    expect(ok).toBe(false);
    expect(applyGithubPrState).not.toHaveBeenCalled();
    expect(messagesSave).toHaveBeenCalledTimes(1);
  });

  it('does NOT post a second method_disallowed note when one already exists', async () => {
    const jobId = 'job-1';
    const { svc, messagesSave, mergePullRequest, getPullDetail } = make({
      mergeResult: {
        ok: false,
        reason: 'method_disallowed',
        status: 422,
        message: 'squash not allowed',
      },
      existingMethodNote: {
        id: 'm-1',
        job_id: jobId,
        ts: `automerge-method:${jobId}:squash`,
      } as Partial<MessageEntity>,
    });
    await svc.mergeNow(jobId, 'user-1');
    expect(messagesSave).not.toHaveBeenCalled();
    expect(getPullDetail).not.toHaveBeenCalled();
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it('the in-flight guard makes a re-entrant call return false immediately without another merge attempt', async () => {
    const { svc, job, mergePullRequest } = make();
    (svc as any).inFlight.add(job.id);
    const ok = await svc.mergeNow(job.id, 'user-1');
    expect(ok).toBe(false);
    expect(mergePullRequest).not.toHaveBeenCalled();
  });
});

describe('AutoMergeService.maybeAutoMerge', () => {
  it('neutralizes the card and does not post/merge when the PR is not merge-ready', async () => {
    const { svc, job, postMergeCard, neutralizeMergeCard, mergePullRequest } =
      make({
        job: makeJobEntity({ pr_mergeable: 'dirty' }),
      });
    await svc.maybeAutoMerge(job.id);
    expect(neutralizeMergeCard).toHaveBeenCalledWith(job.id, 'not-ready');
    expect(postMergeCard).not.toHaveBeenCalled();
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it('posts the merge card but does not auto-merge when auto_merge is off', async () => {
    const { svc, job, postMergeCard, mergePullRequest } = make({
      job: makeJobEntity({ auto_merge: false }),
    });
    await svc.maybeAutoMerge(job.id);
    expect(postMergeCard).toHaveBeenCalledWith(job.id);
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it('posts the merge card AND auto-merges when auto_merge is on and the brain has settled', async () => {
    const { svc, job, postMergeCard, mergePullRequest } = make({
      job: makeJobEntity({ auto_merge: true }),
    });
    await svc.maybeAutoMerge(job.id);
    expect(postMergeCard).toHaveBeenCalledWith(job.id);
    expect(mergePullRequest).toHaveBeenCalled();
  });

  it('posts the merge card but does NOT auto-merge when auto_merge is on but the brain has not settled', async () => {
    const { svc, job, postMergeCard, mergePullRequest } = make({
      job: makeJobEntity({ auto_merge: true, open_question_count: 1 }),
    });
    await svc.maybeAutoMerge(job.id);
    expect(postMergeCard).toHaveBeenCalledWith(job.id);
    expect(mergePullRequest).not.toHaveBeenCalled();
  });
});
