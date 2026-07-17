import { describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import { BrainStoreService } from './brain-store.service';
import type { JobEntity, ThreadEntity } from '../persistence/entities';
import type { JobDependencyService } from '../job-deps';

/**
 * `BrainStoreService.endTurnActivity` — the turn-tail activity settle. Mirrors the mocking pattern in
 * `brain-store.build-not-started.spec.ts`'s `makeStore` (bare-bones `jobs`/`threads` repo stubs, everything
 * else a `never`-cast stub since `endTurnActivity` only reads `this.threads` (a `plan_review` thread's
 * `config.status`, folded off the retired `codex_reviews` row per d7) + `this.jobs`).
 */

function fakeJobsRepo() {
  return {
    findOne: vi.fn(async () => null as Partial<JobEntity> | null),
    update: vi.fn().mockResolvedValue(undefined),
  } as unknown as Repository<JobEntity> & {
    findOne: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
}

function fakeThreadsRepo(reviewing: boolean) {
  return {
    createQueryBuilder: () => {
      const qb: Record<string, unknown> = {};
      for (const m of ['where', 'andWhere']) qb[m] = () => qb;
      qb.getExists = vi.fn(async () => reviewing);
      return qb;
    },
  } as unknown as Repository<ThreadEntity>;
}

function makeStore(opts: {
  jobs: ReturnType<typeof fakeJobsRepo>;
  threads: ReturnType<typeof fakeThreadsRepo>;
}) {
  const stub = {} as never;
  return new BrainStoreService(
    opts.jobs,
    stub, // messages
    stub, // records
    opts.threads,
    stub, // threadGroups
    stub, // stimuli
    stub, // dataSource
    stub, // titler
    {
      onBlockerResolved: vi.fn().mockResolvedValue(undefined),
    } as unknown as JobDependencyService,
    stub, // organizations
  );
}

describe('BrainStoreService.endTurnActivity', () => {
  it('settles to idle when no review is running and the job has no retry park', async () => {
    const jobs = fakeJobsRepo();
    jobs.findOne.mockResolvedValue({ id: 'job-1', session_resume: null });
    const threads = fakeThreadsRepo(false);
    const store = makeStore({ jobs, threads });

    await store.endTurnActivity('job-1');

    expect(jobs.update).toHaveBeenCalledWith(
      { id: 'job-1' },
      { activity: 'idle' },
    );
  });

  it('settles to plan_review when a review is running — the existing carve-out, regardless of session_resume', async () => {
    const jobs = fakeJobsRepo();
    const threads = fakeThreadsRepo(true);
    const store = makeStore({ jobs, threads });

    await store.endTurnActivity('job-1');

    expect(jobs.update).toHaveBeenCalledWith(
      { id: 'job-1' },
      { activity: 'plan_review' },
    );
    // A running review short-circuits the retry-park read entirely (reviewing ? null : jobs.findOne(...)).
    expect(jobs.findOne).not.toHaveBeenCalled();
  });

  it('settles to retrying when the job is parked on a host-retry clock (kind:"retry") and no review is running', async () => {
    const jobs = fakeJobsRepo();
    jobs.findOne.mockResolvedValue({
      id: 'job-1',
      session_resume: {
        at: '2026-07-13T00:10:00.000Z',
        lane: 'main',
        reason: 'retry',
        resetSource: 'usage_api',
        kind: 'retry',
      },
    });
    const threads = fakeThreadsRepo(false);
    const store = makeStore({ jobs, threads });

    await store.endTurnActivity('job-1');

    expect(jobs.update).toHaveBeenCalledWith(
      { id: 'job-1' },
      { activity: 'retrying' },
    );
  });

  it('settles to idle (not retrying) when session_resume is a session_limit park, not a retry park', async () => {
    const jobs = fakeJobsRepo();
    jobs.findOne.mockResolvedValue({
      id: 'job-1',
      session_resume: {
        at: '2026-07-13T00:10:00.000Z',
        lane: 'build',
        reason: 'limit',
        resetSource: 'parsed_string',
        kind: 'session_limit',
      },
    });
    const threads = fakeThreadsRepo(false);
    const store = makeStore({ jobs, threads });

    await store.endTurnActivity('job-1');

    expect(jobs.update).toHaveBeenCalledWith(
      { id: 'job-1' },
      { activity: 'idle' },
    );
  });
});

/** `BrainStoreService.createFollowUpJob` — the `create_job` host-tool `autoMode` resolution rule: an
 *  explicit field wins, an omitted field falls back to the org's `default_auto_approve_mode`/
 *  `default_auto_merge`, and no `autoMode` key at all (onboarding's call sites) leaves the auto_* columns
 *  untouched. Only `jobs` (create/save) + `organizations` (findOne) are exercised — `title` is always null
 *  here so the titler round-trip never fires, and `jobBootstrap` stays unwired (optional, trailing) so
 *  `ensurePlanningThreadGroup` no-ops. */
function fakeCreateJobsRepo() {
  return {
    create: vi.fn((row: Record<string, unknown>) => row),
    save: vi.fn(async (row: Record<string, unknown>) => ({
      id: 'new-job-id',
      ...row,
    })),
  } as unknown as Repository<JobEntity> & {
    create: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
  };
}

function makeCreateFollowUpStore(opts: {
  jobs: ReturnType<typeof fakeCreateJobsRepo>;
  org: Partial<{ default_auto_approve_mode: string; default_auto_merge: boolean }> | null;
}) {
  const stub = {} as never;
  const organizations = {
    findOne: vi.fn(async () => opts.org),
  };
  return {
    store: new BrainStoreService(
      opts.jobs,
      stub, // messages
      stub, // records
      stub, // threads
      stub, // threadGroups
      stub, // stimuli
      stub, // dataSource
      stub, // titler
      {} as unknown as JobDependencyService, // jobDeps
      organizations as never,
    ),
    organizations,
  };
}

describe('BrainStoreService.createFollowUpJob — autoMode', () => {
  it('an explicit autoMode field overrides the org defaults', async () => {
    const jobs = fakeCreateJobsRepo();
    const { store, organizations } = makeCreateFollowUpStore({
      jobs,
      org: { default_auto_approve_mode: 'off', default_auto_merge: false },
    });

    await store.createFollowUpJob({
      orgId: 'org-1',
      repoId: 'repo-1',
      title: null,
      baseBranch: null,
      autoMode: { approveMode: 'ship', merge: true },
    });

    expect(organizations.findOne).toHaveBeenCalledWith({
      where: { id: 'org-1' },
    });
    expect(jobs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        auto_approve_mode: 'ship',
        auto_merge: true,
        auto_approve_by: null,
        auto_merge_by: null,
      }),
    );
  });

  it('an omitted autoMode field inherits the org default', async () => {
    const jobs = fakeCreateJobsRepo();
    const { store } = makeCreateFollowUpStore({
      jobs,
      org: { default_auto_approve_mode: 'plan', default_auto_merge: true },
    });

    await store.createFollowUpJob({
      orgId: 'org-1',
      repoId: 'repo-1',
      title: null,
      baseBranch: null,
      autoMode: {},
    });

    expect(jobs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        auto_approve_mode: 'plan',
        auto_merge: true,
        auto_approve_by: null,
        auto_merge_by: null,
      }),
    );
  });

  it('no autoMode key at all (onboarding) never reads the org and sets no auto_* column', async () => {
    const jobs = fakeCreateJobsRepo();
    const { store, organizations } = makeCreateFollowUpStore({
      jobs,
      org: { default_auto_approve_mode: 'ship', default_auto_merge: true },
    });

    await store.createFollowUpJob({
      orgId: 'org-1',
      repoId: 'repo-1',
      title: null,
      baseBranch: null,
    });

    expect(organizations.findOne).not.toHaveBeenCalled();
    const created = jobs.create.mock.calls[0][0] as Record<string, unknown>;
    expect(created).not.toHaveProperty('auto_approve_mode');
    expect(created).not.toHaveProperty('auto_merge');
    expect(created).not.toHaveProperty('auto_approve_by');
    expect(created).not.toHaveProperty('auto_merge_by');
  });
});
