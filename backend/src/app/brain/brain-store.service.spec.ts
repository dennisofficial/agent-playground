import type { Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { JobDependencyService } from '../job-deps';
import type { JobEntity, ThreadEntity } from '../persistence/entities';
import { BrainStoreService } from './brain-store.service';

/**
 * `BrainStoreService.endTurnActivity` — retained as a compatibility no-op after the job activity/halt
 * columns were removed.
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
  it('does not write the removed activity column when no review is running', async () => {
    const jobs = fakeJobsRepo();
    jobs.findOne.mockResolvedValue({ id: 'job-1', session_resume: null });
    const threads = fakeThreadsRepo(false);
    const store = makeStore({ jobs, threads });

    await store.endTurnActivity('job-1');

    expect(jobs.update).not.toHaveBeenCalled();
  });

  it('does not write the removed activity column when a review is running', async () => {
    const jobs = fakeJobsRepo();
    const threads = fakeThreadsRepo(true);
    const store = makeStore({ jobs, threads });

    await store.endTurnActivity('job-1');

    expect(jobs.findOne).not.toHaveBeenCalled();
    expect(jobs.update).not.toHaveBeenCalled();
  });

  it('does not write retrying when the job is parked on a host-retry clock', async () => {
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

    expect(jobs.update).not.toHaveBeenCalled();
  });

  it('does not write idle when session_resume is a session_limit park', async () => {
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

    expect(jobs.update).not.toHaveBeenCalled();
  });
});
