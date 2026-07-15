/**
 * Unit tests for `GithubPrStateSync` — the silent GitHub `pull_request` webhook fast path. All
 * collaborators (`JobLifecycleService`, `DriverStoreService`, `StimulusStoreService`, the `jobs`
 * repo) are plain mocked objects. No DB, no Docker.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import type { JobEntity } from '../persistence/entities';
import type { DriverStoreService } from './driver-store.service';
import type { JobLifecycleService } from './job-lifecycle.service';
import type { StimulusStoreService } from '../stimulus';
import { GithubPrStateSync } from './github-pr-state-sync.service';
import type { PrStateDelta } from '@shared/domain';

function makeSync() {
  const lifecycle = {
    applyGithubPrState: vi.fn(),
  } as unknown as JobLifecycleService;
  const driverStore = {
    setPrReady: vi.fn(),
    // The post-ship seam (d14): onPrOpened ensures the `ci` thread group thread exists once the PR is recorded.
    ensureCiThread: vi.fn(async () => ({
      threadGroupId: 'tg-ci',
      threadId: 'ci-1',
    })),
  } as unknown as DriverStoreService;
  const stimStore = {
    findOwningJobByBranch: vi.fn(),
    findOwningJobByPrNumber: vi.fn(),
  } as unknown as StimulusStoreService;
  const jobs = { update: vi.fn() } as unknown as Repository<JobEntity>;
  const sync = new GithubPrStateSync(lifecycle, driverStore, stimStore, jobs);
  return { sync, lifecycle, driverStore, stimStore, jobs };
}

describe('GithubPrStateSync.onPrOpened', () => {
  it('records the PR on the owning job when it has none yet', async () => {
    const { sync, driverStore, stimStore } = makeSync();
    (
      stimStore.findOwningJobByBranch as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      id: 'job-1',
      org_id: 'T1',
      decision_record_id: null,
      pr_number: null,
    });

    await sync.onPrOpened(
      'T1',
      'repo-1',
      'feature-x',
      'https://github.com/o/r/pull/9',
      9,
    );

    expect(stimStore.findOwningJobByBranch).toHaveBeenCalledWith(
      'T1',
      'repo-1',
      'feature-x',
    );
    expect(driverStore.setPrReady).toHaveBeenCalledWith(
      'job-1',
      'https://github.com/o/r/pull/9',
      9,
    );
    expect(driverStore.ensureCiThread).toHaveBeenCalledWith({
      jobId: 'job-1',
      orgId: 'T1',
      decisionRecordId: null,
    });
    expect(
      (driverStore.ensureCiThread as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      (driverStore.setPrReady as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0],
    );
  });

  it('is a no-op when the owning job already has a pr_number (idempotent double-delivery)', async () => {
    const { sync, driverStore, stimStore } = makeSync();
    (
      stimStore.findOwningJobByBranch as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      id: 'job-1',
      pr_number: 9,
    });

    await sync.onPrOpened(
      'T1',
      'repo-1',
      'feature-x',
      'https://github.com/o/r/pull/9',
      9,
    );

    expect(driverStore.setPrReady).not.toHaveBeenCalled();
  });

  it('is a no-op when no job owns the branch', async () => {
    const { sync, driverStore, stimStore } = makeSync();
    (
      stimStore.findOwningJobByBranch as ReturnType<typeof vi.fn>
    ).mockResolvedValue(null);

    await sync.onPrOpened(
      'T1',
      'repo-1',
      'feature-x',
      'https://github.com/o/r/pull/9',
      9,
    );

    expect(driverStore.setPrReady).not.toHaveBeenCalled();
  });
});

describe('GithubPrStateSync.onPrClosed', () => {
  it('applies merged when merged=true', async () => {
    const { sync, lifecycle, stimStore } = makeSync();
    const job = { id: 'job-1' };
    (
      stimStore.findOwningJobByPrNumber as ReturnType<typeof vi.fn>
    ).mockResolvedValue(job);

    await sync.onPrClosed('T1', 'repo-1', 9, true);

    expect(stimStore.findOwningJobByPrNumber).toHaveBeenCalledWith(
      'T1',
      'repo-1',
      9,
    );
    expect(lifecycle.applyGithubPrState).toHaveBeenCalledWith(job, 'merged');
  });

  it('applies closed when merged=false', async () => {
    const { sync, lifecycle, stimStore } = makeSync();
    const job = { id: 'job-1' };
    (
      stimStore.findOwningJobByPrNumber as ReturnType<typeof vi.fn>
    ).mockResolvedValue(job);

    await sync.onPrClosed('T1', 'repo-1', 9, false);

    expect(lifecycle.applyGithubPrState).toHaveBeenCalledWith(job, 'closed');
  });

  it('is a no-op when no job owns the PR number', async () => {
    const { sync, lifecycle, stimStore } = makeSync();
    (
      stimStore.findOwningJobByPrNumber as ReturnType<typeof vi.fn>
    ).mockResolvedValue(null);

    await sync.onPrClosed('T1', 'repo-1', 9, true);

    expect(lifecycle.applyGithubPrState).not.toHaveBeenCalled();
  });
});

describe('GithubPrStateSync.onPrReopened', () => {
  it('flips pr_state back to open for the owning job', async () => {
    const { sync, jobs, stimStore } = makeSync();
    (
      stimStore.findOwningJobByPrNumber as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ id: 'job-1' });

    await sync.onPrReopened('T1', 'repo-1', 9);

    expect(jobs.update).toHaveBeenCalledWith(
      { id: 'job-1' },
      { pr_state: 'open' },
    );
  });

  it('is a no-op when no job owns the PR number', async () => {
    const { sync, jobs, stimStore } = makeSync();
    (
      stimStore.findOwningJobByPrNumber as ReturnType<typeof vi.fn>
    ).mockResolvedValue(null);

    await sync.onPrReopened('T1', 'repo-1', 9);

    expect(jobs.update).not.toHaveBeenCalled();
  });
});

describe('GithubPrStateSync.dispatch', () => {
  it('fans out `opened` to onPrOpened', async () => {
    const { sync, driverStore, stimStore } = makeSync();
    (
      stimStore.findOwningJobByBranch as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      id: 'job-1',
      org_id: 'T1',
      decision_record_id: null,
      pr_number: null,
    });
    const delta: PrStateDelta = {
      orgId: 'T1',
      repoId: 'repo-1',
      action: 'opened',
      prNumber: 9,
      headRef: 'feature-x',
      url: 'https://github.com/o/r/pull/9',
      merged: false,
    };

    await sync.dispatch(delta);

    expect(driverStore.setPrReady).toHaveBeenCalledWith(
      'job-1',
      'https://github.com/o/r/pull/9',
      9,
    );
    expect(
      (driverStore.ensureCiThread as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      (driverStore.setPrReady as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0],
    );
  });

  it('fans out `reopened` to onPrReopened', async () => {
    const { sync, jobs, stimStore } = makeSync();
    (
      stimStore.findOwningJobByPrNumber as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ id: 'job-1' });
    const delta: PrStateDelta = {
      orgId: 'T1',
      repoId: 'repo-1',
      action: 'reopened',
      prNumber: 9,
      headRef: 'feature-x',
      url: '',
      merged: false,
    };

    await sync.dispatch(delta);

    expect(jobs.update).toHaveBeenCalledWith(
      { id: 'job-1' },
      { pr_state: 'open' },
    );
  });

  it('fans out `closed` to onPrClosed, respecting the merged flag', async () => {
    const { sync, lifecycle, stimStore } = makeSync();
    const job = { id: 'job-1' };
    (
      stimStore.findOwningJobByPrNumber as ReturnType<typeof vi.fn>
    ).mockResolvedValue(job);
    const delta: PrStateDelta = {
      orgId: 'T1',
      repoId: 'repo-1',
      action: 'closed',
      prNumber: 9,
      headRef: 'feature-x',
      url: '',
      merged: true,
    };

    await sync.dispatch(delta);

    expect(lifecycle.applyGithubPrState).toHaveBeenCalledWith(job, 'merged');
  });
});
