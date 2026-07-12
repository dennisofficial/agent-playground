import { describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import { BrainStoreService } from './brain-store.service';
import type { JobEntity, ThreadEntity } from '../persistence/entities';
import type { JobDependencyService } from '../job-deps';

/**
 * `BrainStoreService.buildNotStarted` — the durable "the approved build has NOT started yet" gate for
 * `hold_build` (§ hold_build host tool, gated on this predicate rather than transient `activity`, since the
 * base-check seed runs on the normal turn path which already stamps `activity='turn'`).
 *
 * Mirrors the mocking pattern in plan-review.service.spec.ts's `makeBrainStore` (a bare-bones jobs/threads
 * repo stub, everything else a `never`-cast stub since buildNotStarted only reads `this.jobs` + `this.threads`).
 */

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
    stub, // steps
    stub, // stimuli
    stub, // reviews
    stub, // dataSource
    stub, // titler
    { onBlockerResolved: vi.fn().mockResolvedValue(undefined) } as unknown as JobDependencyService,
  );
}

describe('BrainStoreService.buildNotStarted', () => {
  it('direct build path, no verification recorded yet → true (not started)', async () => {
    const jobs = fakeJobsRepo({ id: 'job-1', build_path: 'direct', direct_build_verification: null });
    const threads = fakeThreadsRepo([]);
    const store = makeStore({ jobs, threads });
    await expect(store.buildNotStarted('job-1')).resolves.toBe(true);
    expect(threads.find).not.toHaveBeenCalled();
  });

  it('direct build path, verification already recorded → false (started)', async () => {
    const jobs = fakeJobsRepo({
      id: 'job-1',
      build_path: 'direct',
      direct_build_verification: {
        verdict: { runtimeSurfaceTouched: true, liveVerificationAdequate: true, reason: 'ok' },
        at: new Date().toISOString(),
      },
    });
    const threads = fakeThreadsRepo([]);
    const store = makeStore({ jobs, threads });
    await expect(store.buildNotStarted('job-1')).resolves.toBe(false);
  });

  it('plan build path, every root-executable thread still pending → true', async () => {
    const jobs = fakeJobsRepo({ id: 'job-1', build_path: 'plan' });
    const threads = fakeThreadsRepo([
      // Root-executable (builder, top-level, no parent) — still pending.
      { id: 't-1', job_id: 'job-1', kind: 'builder', parent_thread_id: null, status: 'pending' },
      // A second root-executable lane, also pending.
      { id: 't-2', job_id: 'job-1', kind: 'master_review', parent_thread_id: null, status: 'pending' },
      // Non-executable kind (main, the conversational root) — excluded from the filter regardless of status.
      { id: 't-3', job_id: 'job-1', kind: 'main', parent_thread_id: null, status: 'running' },
      // A builder's child review_lens — excluded because it has a parent (not root).
      { id: 't-4', job_id: 'job-1', kind: 'review_lens', parent_thread_id: 't-1', status: 'running' },
    ]);
    const store = makeStore({ jobs, threads });
    await expect(store.buildNotStarted('job-1')).resolves.toBe(true);
  });

  it('plan build path, a root-executable thread has moved past pending → false (started)', async () => {
    const jobs = fakeJobsRepo({ id: 'job-1', build_path: 'plan' });
    const threads = fakeThreadsRepo([
      { id: 't-1', job_id: 'job-1', kind: 'builder', parent_thread_id: null, status: 'executing' },
      { id: 't-2', job_id: 'job-1', kind: 'master_review', parent_thread_id: null, status: 'pending' },
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
