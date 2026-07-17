import type { Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { JobDependencyService } from '../../job-deps/job-dependency.service';
import type { JobEntity, ThreadEntity } from '../../persistence/entities';
import { BrainStoreService } from '../brain-store.service';

function fakeJobsRepo(row: Partial<JobEntity> | null) {
  return {
    findOne: vi.fn(async () => row),
  } as unknown as Repository<JobEntity>;
}

function fakeThreadsRepo(rows: Array<Partial<ThreadEntity>>) {
  return {
    find: vi.fn(async () => rows),
  } as unknown as Repository<ThreadEntity>;
}

function makeStore(opts: { jobs: Repository<JobEntity>; threads: Repository<ThreadEntity> }) {
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

describe('BrainStoreService.buildNotStarted', () => {
  it('direct build path, not started yet → true (not started)', async () => {
    const jobs = fakeJobsRepo({
      id: 'job-1',
      build_path: 'direct',
      direct_build_started_at: null,
    });
    const threads = fakeThreadsRepo([]);
    const store = makeStore({ jobs, threads });
    await expect(store.buildNotStarted('job-1')).resolves.toBe(true);
    expect(threads.find).not.toHaveBeenCalled();
  });

  it('direct build path, start marker stamped → false (started, even mid-implementation before finalize)', async () => {
    const jobs = fakeJobsRepo({
      id: 'job-1',
      build_path: 'direct',
      direct_build_started_at: new Date(),
      direct_build_verification: null,
    });
    const threads = fakeThreadsRepo([]);
    const store = makeStore({ jobs, threads });
    await expect(store.buildNotStarted('job-1')).resolves.toBe(false);
  });

  it('plan build path, every root-executable thread still pending → true', async () => {
    const jobs = fakeJobsRepo({ id: 'job-1', build_path: 'plan' });
    const threads = fakeThreadsRepo([
      {
        id: 't-1',
        job_id: 'job-1',
        role: 'builder',
        parent_thread_id: null,
        status: 'pending',
      },
      {
        id: 't-2',
        job_id: 'job-1',
        role: 'master_review',
        parent_thread_id: null,
        status: 'pending',
      },
      {
        id: 't-3',
        job_id: 'job-1',
        role: 'planning',
        parent_thread_id: null,
        status: 'running',
      },
      {
        id: 't-4',
        job_id: 'job-1',
        role: 'review_agent',
        parent_thread_id: 't-1',
        status: 'running',
      },
    ]);
    const store = makeStore({ jobs, threads });
    await expect(store.buildNotStarted('job-1')).resolves.toBe(true);
  });

  it('plan build path, a root-executable thread has moved past pending → false (started)', async () => {
    const jobs = fakeJobsRepo({ id: 'job-1', build_path: 'plan' });
    const threads = fakeThreadsRepo([
      {
        id: 't-1',
        job_id: 'job-1',
        role: 'builder',
        parent_thread_id: null,
        status: 'executing',
      },
      {
        id: 't-2',
        job_id: 'job-1',
        role: 'master_review',
        parent_thread_id: null,
        status: 'pending',
      },
    ]);
    const store = makeStore({ jobs, threads });
    await expect(store.buildNotStarted('job-1')).resolves.toBe(false);
  });

  it('missing job row → false', async () => {
    const jobs = fakeJobsRepo(null);
    const threads = fakeThreadsRepo([]);
    const store = makeStore({ jobs, threads });
    await expect(store.buildNotStarted('nonexistent')).resolves.toBe(false);
    expect(threads.find).not.toHaveBeenCalled();
  });
});
