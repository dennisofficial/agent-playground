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
