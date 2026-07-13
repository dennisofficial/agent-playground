/**
 * Unit tests for `JobLifecycleService.rowToSandbox` (accessed via a cast to bypass `private`).
 *
 * Verifies: `execUser` is recomputed from the host process uid:gid when the persisted row has a
 * `container_id` (docker mode) and absent otherwise; and that the branch is sourced from the THREAD
 * (feature_branch → base_branch) while the on-disk repo identity is the repo's SLUG — the sandbox row
 * itself no longer carries the branch (single owner = the thread).
 *
 * No DB, no Docker — all TypeORM repositories are mocked stubs.
 */

import type { EnvService } from '@core/config/env/env.service';
import type { ModuleRef } from '@nestjs/core';
import type { BrainGateway } from '../brain-gateway';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import type {
  RepoEntity,
  JobEntity,
  JobSandboxEntity,
} from '../persistence/entities';
import type { GithubPrService, LocalGitService } from '../git';
import type { CredentialResolver } from '../onboarding';
import type { SkillUpdaterService } from '../skills/skill-updater.service';
import type { DriverRepoResolver } from './repo-resolver';
import { SandboxActivityRegistry, type SandboxProvider } from '../sandbox';
import { TurnRegistry } from '../sandbox/turn-registry.service';
import { JobLifecycleService } from './job-lifecycle.service';
import type { DriverStoreService } from './driver-store.service';
import type { JobDependencyService } from '../job-deps';
import type { WorktreeProvisioner } from './worktree-provisioner.service';

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

/** Build a bare-minimum JobSandboxEntity row (infra-only — no branch/PR; those live on the thread). */
function makeRow(overrides: Partial<JobSandboxEntity> = {}): JobSandboxEntity {
  return {
    id: 'sandbox-1',
    org_id: 'T1',
    job_id: 'thread-1',
    repo_id: 'repo-uuid-1',
    worktree_path: '/repos/proj/.worktrees/thread-1',
    container_id: null,
    lifecycle: 'attached',
    session_id: null,
    last_active_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as JobSandboxEntity;
}

/**
 * Construct a JobLifecycleService whose `threads`/`projects` repos return the given thread + repo, so
 * `rowToSandbox` can resolve the branch (from the thread) and the on-disk slug (from the repo).
 */
function makeService(
  thread: Partial<JobEntity> = {},
  repo: Partial<RepoEntity> = {},
): JobLifecycleService {
  const threadRow = { id: 'thread-1', feature_branch: null, base_branch: 'main', ...thread };
  const repoRow = { id: 'repo-uuid-1', slug: 'proj', default_branch: 'main', ...repo };
  const threads = { findOne: vi.fn().mockResolvedValue(threadRow) } as unknown as Repository<JobEntity>;
  const projects = { findOne: vi.fn().mockResolvedValue(repoRow) } as unknown as Repository<RepoEntity>;
  const sandboxes = { findOne: vi.fn(), save: vi.fn(), create: vi.fn() } as unknown as Repository<JobSandboxEntity>;

  return new JobLifecycleService(
    threads,
    sandboxes,
    projects,
    {} as unknown as LocalGitService,
    { getPullState: vi.fn() } as unknown as GithubPrService,
    { githubToken: vi.fn() } as unknown as CredentialResolver,
    { get: vi.fn() } as unknown as EnvService,
    new SandboxActivityRegistry(),
    { resolve: vi.fn() } as unknown as DriverRepoResolver,
    { attach: vi.fn(), teardown: vi.fn(), teardownByIdentity: vi.fn() } as unknown as SandboxProvider,
    { provisionAndAttach: vi.fn() } as unknown as WorktreeProvisioner,
    { onBlockerResolved: vi.fn().mockResolvedValue(undefined) } as unknown as JobDependencyService,
    { failRunningForJob: vi.fn().mockResolvedValue(0) } as unknown as TurnRegistry,
    { get: vi.fn() } as unknown as ModuleRef,
    { wakeForProvisioningFailure: vi.fn() } as unknown as BrainGateway,
    { reconcileOrgAsync: vi.fn() } as unknown as SkillUpdaterService,
    { neutralizeMergeCard: vi.fn().mockResolvedValue(undefined) } as unknown as DriverStoreService,
  );
}

/** Build a service whose sandbox repo + provisioner are controllable, for rehydrateThread tests. */
function makeServiceWithMocks(
  row: JobSandboxEntity | null,
  hydrationSig = 'new',
  sandboxExtra: Partial<import('../git').FeatureSandbox> = {},
) {
  const sandboxes = {
    findOne: vi.fn().mockResolvedValue(row),
    save: vi.fn(),
    create: vi.fn(),
  } as unknown as Repository<JobSandboxEntity>;
  const provisionAndAttach = vi.fn().mockResolvedValue({
    sandbox: { worktreePath: row?.worktree_path, containerId: 'c1', repoId: 'proj', branch: 'main', ...sandboxExtra },
    hydrationSig,
  });
  const svc = new JobLifecycleService(
    { findOne: vi.fn().mockResolvedValue({ id: 'thread-1', feature_branch: null, base_branch: 'main' }) } as unknown as Repository<JobEntity>,
    sandboxes,
    { findOne: vi.fn().mockResolvedValue({ id: 'repo-uuid-1', slug: 'proj', default_branch: 'main' }) } as unknown as Repository<RepoEntity>,
    {} as unknown as LocalGitService,
    { getPullState: vi.fn() } as unknown as GithubPrService,
    { githubToken: vi.fn() } as unknown as CredentialResolver,
    { get: vi.fn() } as unknown as EnvService,
    new SandboxActivityRegistry(),
    { resolve: vi.fn() } as unknown as DriverRepoResolver,
    { attach: vi.fn(), teardown: vi.fn(), teardownByIdentity: vi.fn() } as unknown as SandboxProvider,
    { provisionAndAttach } as unknown as WorktreeProvisioner,
    { onBlockerResolved: vi.fn().mockResolvedValue(undefined) } as unknown as JobDependencyService,
    { failRunningForJob: vi.fn().mockResolvedValue(0) } as unknown as TurnRegistry,
    { get: vi.fn() } as unknown as ModuleRef,
    { wakeForProvisioningFailure: vi.fn() } as unknown as BrainGateway,
    { reconcileOrgAsync: vi.fn() } as unknown as SkillUpdaterService,
    { neutralizeMergeCard: vi.fn().mockResolvedValue(undefined) } as unknown as DriverStoreService,
  );
  return { svc, sandboxes, provisionAndAttach };
}

/**
 * Build a service whose sandbox repo + teardown provider + activity registry are controllable, for
 * `resetContainer` tests (which tear the container down but keep the worktree/session).
 */
function makeServiceForReset(
  row: JobSandboxEntity | null,
  jobActivity: JobEntity['activity'] = 'idle',
) {
  const sandboxes = {
    find: vi.fn().mockResolvedValue(row ? [row] : []),
    findOne: vi.fn().mockResolvedValue(row),
    save: vi.fn(),
    create: vi.fn(),
  } as unknown as Repository<JobSandboxEntity>;
  const teardown = vi.fn().mockResolvedValue(undefined);
  const activity = new SandboxActivityRegistry();
  const failRunningForJob = vi.fn().mockResolvedValue(0);
  const svc = new JobLifecycleService(
    {
      findOne: vi.fn().mockResolvedValue({
        id: 'thread-1',
        feature_branch: null,
        base_branch: 'main',
        activity: jobActivity,
      }),
    } as unknown as Repository<JobEntity>,
    sandboxes,
    { findOne: vi.fn().mockResolvedValue({ id: 'repo-uuid-1', slug: 'proj', default_branch: 'main' }) } as unknown as Repository<RepoEntity>,
    {} as unknown as LocalGitService,
    { getPullState: vi.fn() } as unknown as GithubPrService,
    { githubToken: vi.fn() } as unknown as CredentialResolver,
    { get: vi.fn() } as unknown as EnvService,
    activity,
    { resolve: vi.fn() } as unknown as DriverRepoResolver,
    { attach: vi.fn(), teardown, teardownByIdentity: vi.fn() } as unknown as SandboxProvider,
    { provisionAndAttach: vi.fn() } as unknown as WorktreeProvisioner,
    { onBlockerResolved: vi.fn().mockResolvedValue(undefined) } as unknown as JobDependencyService,
    { failRunningForJob } as unknown as TurnRegistry,
    { get: vi.fn() } as unknown as ModuleRef,
    { wakeForProvisioningFailure: vi.fn() } as unknown as BrainGateway,
    { reconcileOrgAsync: vi.fn() } as unknown as SkillUpdaterService,
    { neutralizeMergeCard: vi.fn().mockResolvedValue(undefined) } as unknown as DriverStoreService,
  );
  return { svc, sandboxes, teardown, activity, failRunningForJob };
}

// Cast to access the private (now-async) rowToSandbox method from tests.
function rowToSandbox(svc: JobLifecycleService, row: JobSandboxEntity) {
  return (
    svc as unknown as {
      rowToSandbox(r: JobSandboxEntity): Promise<import('../git').FeatureSandbox>;
    }
  ).rowToSandbox(row);
}

// ── tests ────────────────────────────────────────────────────────────────────────────────────────

describe('JobLifecycleService.rowToSandbox', () => {
  it('populates execUser with the host uid:gid for a row WITH a container_id (docker mode)', async () => {
    const svc = makeService();
    const row = makeRow({ container_id: 'abc123def456' });

    const sandbox = await rowToSandbox(svc, row);

    // containerId must be propagated.
    expect(sandbox).toMatchObject({ containerId: 'abc123def456' });

    // execUser must be recomputed — on Linux/macOS process.getuid/getgid are available.
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;

    if (uid !== undefined && gid !== undefined) {
      expect(sandbox.execUser).toBe(`${uid}:${gid}`);
    } else {
      // On platforms without uid/gid (e.g. Windows CI), the field must be absent.
      expect(sandbox.execUser).toBeUndefined();
    }
  });

  it('omits execUser for a row WITHOUT a container_id (local mode)', async () => {
    const svc = makeService();
    const row = makeRow({ container_id: null });

    const sandbox = await rowToSandbox(svc, row);

    expect(sandbox.containerId).toBeUndefined();
    expect(sandbox.execUser).toBeUndefined();
  });

  it('uses the on-disk repo SLUG as the sandbox repoId', async () => {
    const svc = makeService({}, { slug: 'my-repo' });
    const sandbox = await rowToSandbox(svc, makeRow({ container_id: 'x' }));
    expect(sandbox.repoId).toBe('my-repo');
  });

  it('uses the thread feature_branch when set, falls back to base_branch', async () => {
    const branched = await rowToSandbox(
      makeService({ feature_branch: 'atlas/feature-abc', base_branch: 'main' }),
      makeRow({ container_id: 'x' }),
    );
    expect(branched.branch).toBe('atlas/feature-abc');

    const base = await rowToSandbox(
      makeService({ feature_branch: null, base_branch: 'main' }),
      makeRow({ container_id: 'x' }),
    );
    expect(base.branch).toBe('main');
  });
});

describe('JobLifecycleService.rehydrateThread', () => {
  it('force-hydrates the live worktree and persists the new signature', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'atlas-rehy-'));
    try {
      const row = makeRow({ worktree_path: wt, hydration_sig: 'old' } as Partial<JobSandboxEntity>);
      const { svc, sandboxes, provisionAndAttach } = makeServiceWithMocks(row, 'new-sig');

      const ok = await svc.rehydrateThread('thread-1', 'T1');

      expect(ok).toBe(true);
      expect(provisionAndAttach).toHaveBeenCalledWith(
        expect.objectContaining({ forceHydrate: true, jobId: 'thread-1', orgId: 'T1' }),
      );
      expect(sandboxes.save).toHaveBeenCalled();
      expect((row as JobSandboxEntity).hydration_sig).toBe('new-sig');
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it('is a no-op (false) when the worktree is gone — the next real turn hydrates it', async () => {
    const row = makeRow({ worktree_path: '/atlas/does-not-exist/thread-1' });
    const { svc, provisionAndAttach } = makeServiceWithMocks(row);
    expect(await svc.rehydrateThread('thread-1', 'T1')).toBe(false);
    expect(provisionAndAttach).not.toHaveBeenCalled();
  });

  it('is a no-op (false) when there is no sandbox row', async () => {
    const { svc, provisionAndAttach } = makeServiceWithMocks(null);
    expect(await svc.rehydrateThread('thread-1', 'T1')).toBe(false);
    expect(provisionAndAttach).not.toHaveBeenCalled();
  });
});

describe('JobLifecycleService.resetContainer', () => {
  it('tears down + detaches the container while preserving the durable worktree and resume session', async () => {
    const row = makeRow({ container_id: 'c-live', worktree_path: '/wt/keep', session_id: 'sess-keep' });
    const { svc, sandboxes, teardown } = makeServiceForReset(row);

    const res = await svc.resetContainer('thread-1', 'T1');

    expect(res).toEqual({ reset: true });
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(row.container_id).toBeNull();
    expect(row.lifecycle).toBe('detached');
    expect(row.worktree_path).toBe('/wt/keep'); // host bind — untouched, so files survive the reset
    expect(row.session_id).toBe('sess-keep'); // resume survives → next attach resumes the same session
    expect(sandboxes.save).toHaveBeenCalled();
  });

  it('drops any running turn row for the job before tearing the container down (no swallowed steer)', async () => {
    const row = makeRow({ container_id: 'c-live' });
    const { svc, failRunningForJob } = makeServiceForReset(row);

    await svc.resetContainer('thread-1', 'T1');

    // The engine is about to die → its `active_turns` row must be finalized so the steer path can't treat
    // it as a live turn and XADD the operator's next message into an unread input stream (silent loss).
    expect(failRunningForJob).toHaveBeenCalledWith('thread-1');
  });

  it('returns no-container (no teardown) when the row has no live container', async () => {
    const { svc, teardown } = makeServiceForReset(makeRow({ container_id: null }));
    expect(await svc.resetContainer('thread-1', 'T1')).toEqual({ reset: false, reason: 'no-container' });
    expect(teardown).not.toHaveBeenCalled();
  });

  it('returns no-container when there is no sandbox row', async () => {
    const { svc } = makeServiceForReset(null);
    expect(await svc.resetContainer('thread-1', 'T1')).toEqual({ reset: false, reason: 'no-container' });
  });

  it('refuses (busy) — never tears down a container with a turn/build executing in it', async () => {
    const row = makeRow({ container_id: 'c-busy' });
    const { svc, teardown, activity } = makeServiceForReset(row);
    activity.enter('c-busy'); // a driver build/turn is live on this container right now

    expect(await svc.resetContainer('thread-1', 'T1')).toEqual({ reset: false, reason: 'busy' });
    expect(teardown).not.toHaveBeenCalled();
    expect(row.lifecycle).toBe('attached'); // untouched
  });
});

describe('JobLifecycleService.reapIdle', () => {
  it('does not reap a sandbox while the durable job activity is non-idle', async () => {
    const row = makeRow({ container_id: 'c-review', last_active_at: new Date(0) });
    const { svc, teardown } = makeServiceForReset(row, 'plan_review');

    expect(await svc.reapIdle()).toBe(0);
    expect(teardown).not.toHaveBeenCalled();
    expect(row.lifecycle).toBe('attached');
  });

  it('reaps an old attached sandbox once the durable job activity is idle', async () => {
    const row = makeRow({ container_id: 'c-idle', last_active_at: new Date(0) });
    const { svc, teardown } = makeServiceForReset(row);

    expect(await svc.reapIdle()).toBe(1);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(row.lifecycle).toBe('detached');
  });
});

describe('JobLifecycleService — onMilestone forwarding', () => {
  it('ensureContainer forwards onMilestone into provisionAndAttach', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'atlas-milestone-'));
    try {
      const row = makeRow({ worktree_path: wt });
      const { svc, provisionAndAttach } = makeServiceWithMocks(row);
      const onMilestone = vi.fn();

      await svc.ensureContainer('thread-1', 'T1', onMilestone);

      expect(provisionAndAttach).toHaveBeenCalledWith(expect.objectContaining({ onMilestone }));
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe('JobLifecycleService — cold-boot setup_error stamping (ensureContainer)', () => {
  it('stamps setup_error on the row when the setup script failed', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'atlas-setup-'));
    try {
      const row = makeRow({ worktree_path: wt });
      const { svc, sandboxes } = makeServiceWithMocks(row, 'sig', {
        setupScriptResult: { ok: false, exitCode: 2, tail: 'boom' },
      });

      await svc.ensureContainer('thread-1', 'T1');

      const saved = (sandboxes.save as unknown as { mock: { calls: JobSandboxEntity[][] } }).mock.calls.at(-1)![0];
      expect(saved.setup_error).toBe('exit 2: boom');
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it('clears setup_error (null) when the setup script succeeded / there was none', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'atlas-setup-'));
    try {
      const row = makeRow({ worktree_path: wt, setup_error: 'exit 1: stale' });
      const { svc, sandboxes } = makeServiceWithMocks(row, 'sig'); // no setupScriptResult

      await svc.ensureContainer('thread-1', 'T1');

      const saved = (sandboxes.save as unknown as { mock: { calls: JobSandboxEntity[][] } }).mock.calls.at(-1)![0];
      expect(saved.setup_error).toBeNull();
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe('JobLifecycleService.applyGithubPrState', () => {
  /**
   * Build a service whose `jobs.update` and `detachJobContainer` (spied on the instance) both push a label
   * into a shared `order` array, so tests can assert both invocation AND sequence. Merge now DETACHES (frees
   * RAM, keeps worktree + session) rather than closing — so a follow-up can resume with full context.
   */
  function makeServiceForApply() {
    const order: string[] = [];
    const jobs = {
      update: vi.fn(async (_where: unknown, patch: { pr_state?: string }) => {
        order.push(`update:${patch.pr_state}`);
        return { affected: 1 };
      }),
    } as unknown as Repository<JobEntity>;
    const neutralizeMergeCard = vi.fn().mockResolvedValue(undefined);
    const svc = new JobLifecycleService(
      jobs,
      { findOne: vi.fn(), save: vi.fn(), create: vi.fn() } as unknown as Repository<JobSandboxEntity>,
      { findOne: vi.fn() } as unknown as Repository<RepoEntity>,
      {} as unknown as LocalGitService,
      { getPullState: vi.fn() } as unknown as GithubPrService,
      { githubToken: vi.fn() } as unknown as CredentialResolver,
      { get: vi.fn() } as unknown as EnvService,
      new SandboxActivityRegistry(),
      { resolve: vi.fn() } as unknown as DriverRepoResolver,
      { attach: vi.fn(), teardown: vi.fn(), teardownByIdentity: vi.fn() } as unknown as SandboxProvider,
      { provisionAndAttach: vi.fn() } as unknown as WorktreeProvisioner,
      { onBlockerResolved: vi.fn().mockResolvedValue(undefined) } as unknown as JobDependencyService,
      { failRunningForJob: vi.fn().mockResolvedValue(0) } as unknown as TurnRegistry,
      { get: vi.fn() } as unknown as ModuleRef,
      { wakeForProvisioningFailure: vi.fn() } as unknown as BrainGateway,
      { reconcileOrgAsync: vi.fn() } as unknown as SkillUpdaterService,
      { neutralizeMergeCard } as unknown as DriverStoreService,
    );
    svc.detachJobContainer = vi.fn(async () => {
      order.push('detach');
    });
    return { svc, jobs, order, neutralizeMergeCard };
  }

  const job = { id: 'job-1', org_id: 'T1', repo_id: 'repo-1' } as JobEntity;

  it("state='open' is a no-op — no update, no teardown", async () => {
    const { svc, jobs } = makeServiceForApply();
    const result = await svc.applyGithubPrState(job, 'open');
    expect(result).toBe('noop');
    expect(jobs.update).not.toHaveBeenCalled();
    expect(svc.detachJobContainer).not.toHaveBeenCalled();
  });

  it("state='merged' writes pr_state=merged, then DETACHES (frees RAM, keeps worktree) — in that order", async () => {
    const { svc, jobs, order, neutralizeMergeCard } = makeServiceForApply();
    const result = await svc.applyGithubPrState(job, 'merged');
    expect(result).toBe('closed');
    expect(jobs.update).toHaveBeenCalledWith({ id: 'job-1' }, { pr_state: 'merged' });
    expect(order).toEqual(['update:merged', 'detach']);
    expect(neutralizeMergeCard).toHaveBeenCalledWith('job-1', 'merged');
  });

  it("state='closed' writes pr_state=closed, then detaches", async () => {
    const { svc, jobs, order, neutralizeMergeCard } = makeServiceForApply();
    const result = await svc.applyGithubPrState(job, 'closed');
    expect(result).toBe('closed');
    expect(jobs.update).toHaveBeenCalledWith({ id: 'job-1' }, { pr_state: 'closed' });
    expect(order).toEqual(['update:closed', 'detach']);
    expect(neutralizeMergeCard).toHaveBeenCalledWith('job-1', 'not-ready');
  });

  it("state='gone' folds to pr_state=closed and still detaches the job", async () => {
    const { svc, jobs, order } = makeServiceForApply();
    const result = await svc.applyGithubPrState(job, 'gone');
    expect(result).toBe('closed');
    expect(jobs.update).toHaveBeenCalledWith({ id: 'job-1' }, { pr_state: 'closed' });
    expect(order).toEqual(['update:closed', 'detach']);
  });
});

describe('JobLifecycleService.closeJobPullRequest', () => {
  /** Build a service whose `projects`/`creds`/`pr` are controllable, for closeJobPullRequest tests. */
  function makeServiceForClose(repo: Partial<RepoEntity> | null) {
    const projects = {
      findOne: vi.fn().mockResolvedValue(repo),
    } as unknown as Repository<RepoEntity>;
    const closePullRequest = vi.fn().mockResolvedValue(undefined);
    const githubToken = vi.fn().mockResolvedValue('TOK');
    const svc = new JobLifecycleService(
      { findOne: vi.fn() } as unknown as Repository<JobEntity>,
      { findOne: vi.fn(), save: vi.fn(), create: vi.fn() } as unknown as Repository<JobSandboxEntity>,
      projects,
      {} as unknown as LocalGitService,
      { closePullRequest } as unknown as GithubPrService,
      { githubToken } as unknown as CredentialResolver,
      { get: vi.fn() } as unknown as EnvService,
      new SandboxActivityRegistry(),
      { resolve: vi.fn() } as unknown as DriverRepoResolver,
      { attach: vi.fn(), teardown: vi.fn(), teardownByIdentity: vi.fn() } as unknown as SandboxProvider,
      { provisionAndAttach: vi.fn() } as unknown as WorktreeProvisioner,
      { onBlockerResolved: vi.fn().mockResolvedValue(undefined) } as unknown as JobDependencyService,
      { failRunningForJob: vi.fn().mockResolvedValue(0) } as unknown as TurnRegistry,
      { get: vi.fn() } as unknown as ModuleRef,
      { wakeForProvisioningFailure: vi.fn() } as unknown as BrainGateway,
      { reconcileOrgAsync: vi.fn() } as unknown as SkillUpdaterService,
      { neutralizeMergeCard: vi.fn().mockResolvedValue(undefined) } as unknown as DriverStoreService,
    );
    return { svc, projects, closePullRequest, githubToken };
  }

  it('no-ops (never calls pr.closePullRequest) when the job has no open PR', async () => {
    const { svc, closePullRequest } = makeServiceForClose({
      id: 'repo-1',
      git_url: 'https://github.com/acme/app.git',
    });

    await svc.closeJobPullRequest({
      id: 'job-1',
      org_id: 'T1',
      repo_id: 'repo-1',
      pr_state: 'merged',
      pr_number: 9,
    } as JobEntity);

    expect(closePullRequest).not.toHaveBeenCalled();
  });

  it('throws when pr_state is open but pr_number is null', async () => {
    const { svc, closePullRequest } = makeServiceForClose({
      id: 'repo-1',
      git_url: 'https://github.com/acme/app.git',
    });

    await expect(
      svc.closeJobPullRequest({
        id: 'job-1',
        org_id: 'T1',
        repo_id: 'repo-1',
        pr_state: 'open',
        pr_number: null,
      } as JobEntity),
    ).rejects.toThrow(/missing PR number/);

    expect(closePullRequest).not.toHaveBeenCalled();
  });

  it('resolves the repo + token and closes the PR when pr_state is open', async () => {
    const { svc, projects, closePullRequest, githubToken } = makeServiceForClose({
      id: 'repo-1',
      git_url: 'https://github.com/acme/app.git',
    });

    await svc.closeJobPullRequest({
      id: 'job-1',
      org_id: 'T1',
      repo_id: 'repo-1',
      pr_state: 'open',
      pr_number: 9,
    } as JobEntity);

    expect(projects.findOne).toHaveBeenCalledWith({ where: { id: 'repo-1', org_id: 'T1' } });
    expect(githubToken).toHaveBeenCalledWith('T1');
    expect(closePullRequest).toHaveBeenCalledWith('TOK', {
      owner: 'acme',
      repo: 'app',
      number: 9,
    });
  });

  it('throws when the repo or token cannot be resolved', async () => {
    const { svc, closePullRequest } = makeServiceForClose(null);

    await expect(
      svc.closeJobPullRequest({
        id: 'job-1',
        org_id: 'T1',
        repo_id: 'repo-1',
        pr_state: 'open',
        pr_number: 9,
      } as JobEntity),
    ).rejects.toThrow(/job-1/);
    expect(closePullRequest).not.toHaveBeenCalled();
  });
});

describe('JobLifecycleService — merge detaches (keeps context) + stale-sandbox disk GC', () => {
  // detachJobContainer: the RAM-free twin of closeJob — reclaim the container by identity, KEEP the worktree
  // + session, mark 'detached'. Exposes the teardown + worktree spies so we can assert what it does/doesn't do.
  function makeServiceForDetach(row: JobSandboxEntity | null) {
    const teardownByIdentity = vi.fn().mockResolvedValue(undefined);
    const removeSandbox = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue({ affected: 1 });
    const sandboxes = {
      findOne: vi.fn().mockResolvedValue(row),
      update,
      save: vi.fn(),
      create: vi.fn(),
      find: vi.fn(),
    } as unknown as Repository<JobSandboxEntity>;
    const svc = new JobLifecycleService(
      { findOne: vi.fn().mockResolvedValue({ id: 'thread-1', feature_branch: 'atlas/f', base_branch: 'main' }) } as unknown as Repository<JobEntity>,
      sandboxes,
      { findOne: vi.fn().mockResolvedValue({ id: 'repo-uuid-1', slug: 'proj', default_branch: 'main', git_url: 'https://github.com/a/b' }) } as unknown as Repository<RepoEntity>,
      { removeSandbox } as unknown as LocalGitService,
      { getPullState: vi.fn() } as unknown as GithubPrService,
      { githubToken: vi.fn() } as unknown as CredentialResolver,
      { get: vi.fn() } as unknown as EnvService,
      new SandboxActivityRegistry(),
      { resolve: vi.fn() } as unknown as DriverRepoResolver,
      { attach: vi.fn(), teardown: vi.fn(), teardownByIdentity } as unknown as SandboxProvider,
      { provisionAndAttach: vi.fn() } as unknown as WorktreeProvisioner,
      { onBlockerResolved: vi.fn().mockResolvedValue(undefined) } as unknown as JobDependencyService,
      { failRunningForJob: vi.fn().mockResolvedValue(0) } as unknown as TurnRegistry,
      { get: vi.fn() } as unknown as ModuleRef,
      { wakeForProvisioningFailure: vi.fn() } as unknown as BrainGateway,
      { reconcileOrgAsync: vi.fn() } as unknown as SkillUpdaterService,
      { neutralizeMergeCard: vi.fn().mockResolvedValue(undefined) } as unknown as DriverStoreService,
    );
    return { svc, sandboxes, update, teardownByIdentity, removeSandbox };
  }

  it('detachJobContainer frees the container (by identity) + marks detached, but KEEPS the worktree + session', async () => {
    const row = makeRow({ lifecycle: 'attached', container_id: 'c1', worktree_path: '/wt', session_id: 'sess-1' });
    const { svc, update, teardownByIdentity, removeSandbox } = makeServiceForDetach(row);

    await svc.detachJobContainer('thread-1', 'T1');

    expect(teardownByIdentity).toHaveBeenCalledTimes(1); // container reclaimed by deterministic name
    expect(removeSandbox).not.toHaveBeenCalled(); // worktree KEPT (the whole point — resume needs it)
    // Scoped update, container freed, lifecycle detached; session_id untouched (not in the patch).
    expect(update).toHaveBeenCalledWith({ id: row.id }, { container_id: null, lifecycle: 'detached' });
  });

  it('detachJobContainer still tears down a boot-reconciled DETACHED row (container_id null but real container may run)', async () => {
    const row = makeRow({ lifecycle: 'detached', container_id: null, worktree_path: '/wt' });
    const { svc, teardownByIdentity } = makeServiceForDetach(row);

    await svc.detachJobContainer('thread-1', 'T1');

    expect(teardownByIdentity).toHaveBeenCalledTimes(1); // does NOT short-circuit on 'detached'
  });

  it('detachJobContainer no-ops on an already-CLOSED row (fully torn down)', async () => {
    const row = makeRow({ lifecycle: 'closed', container_id: null });
    const { svc, update, teardownByIdentity } = makeServiceForDetach(row);

    await svc.detachJobContainer('thread-1', 'T1');

    expect(teardownByIdentity).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('a detached row with worktree + feature_branch is RESUMABLE — ensureProvisioned returns it (not null)', async () => {
    const row = makeRow({ lifecycle: 'detached', worktree_path: '/wt/thread-1', session_id: 'sess-1' });
    const svc = new JobLifecycleService(
      { findOne: vi.fn().mockResolvedValue({ id: 'thread-1', feature_branch: 'atlas/f', base_branch: 'main' }) } as unknown as Repository<JobEntity>,
      { findOne: vi.fn().mockResolvedValue(row), update: vi.fn(), save: vi.fn(), create: vi.fn() } as unknown as Repository<JobSandboxEntity>,
      { findOne: vi.fn().mockResolvedValue({ id: 'repo-uuid-1', slug: 'proj', default_branch: 'main' }) } as unknown as Repository<RepoEntity>,
      {} as unknown as LocalGitService,
      { getPullState: vi.fn() } as unknown as GithubPrService,
      { githubToken: vi.fn() } as unknown as CredentialResolver,
      { get: vi.fn() } as unknown as EnvService,
      new SandboxActivityRegistry(),
      { resolve: vi.fn() } as unknown as DriverRepoResolver,
      { attach: vi.fn(), teardown: vi.fn(), teardownByIdentity: vi.fn() } as unknown as SandboxProvider,
      { provisionAndAttach: vi.fn() } as unknown as WorktreeProvisioner,
      { onBlockerResolved: vi.fn().mockResolvedValue(undefined) } as unknown as JobDependencyService,
      { failRunningForJob: vi.fn().mockResolvedValue(0) } as unknown as TurnRegistry,
      { get: vi.fn() } as unknown as ModuleRef,
      { wakeForProvisioningFailure: vi.fn() } as unknown as BrainGateway,
      { reconcileOrgAsync: vi.fn() } as unknown as SkillUpdaterService,
      { neutralizeMergeCard: vi.fn().mockResolvedValue(undefined) } as unknown as DriverStoreService,
    );

    const out = await svc.ensureProvisioned('thread-1', 'T1');
    expect(out).toBe(row); // resumable — contrast the 'closed' → null gate
  });

  // ── pollPrClosures no longer re-polls already-terminal (detached merged) jobs ──────────────────────
  function makeServiceForPoll(
    job: Partial<JobEntity>,
    sandbox: JobSandboxEntity | null,
    pullState: 'open' | 'merged' | 'closed' = 'open',
  ) {
    const getPullState = vi.fn().mockResolvedValue(pullState);
    const svc = new JobLifecycleService(
      {
        find: vi.fn().mockResolvedValue([{ id: 'thread-1', org_id: 'T1', repo_id: 'repo-1', pr_number: 5, ...job }]),
        update: vi.fn().mockResolvedValue({ affected: 1 }),
      } as unknown as Repository<JobEntity>,
      { findOne: vi.fn().mockResolvedValue(sandbox) } as unknown as Repository<JobSandboxEntity>,
      { findOne: vi.fn().mockResolvedValue({ id: 'repo-1', git_url: 'https://github.com/a/b' }) } as unknown as Repository<RepoEntity>,
      {} as unknown as LocalGitService,
      { getPullState } as unknown as GithubPrService,
      { githubToken: vi.fn().mockResolvedValue('ghtok') } as unknown as CredentialResolver,
      { get: vi.fn() } as unknown as EnvService,
      new SandboxActivityRegistry(),
      { resolve: vi.fn() } as unknown as DriverRepoResolver,
      { attach: vi.fn(), teardown: vi.fn(), teardownByIdentity: vi.fn() } as unknown as SandboxProvider,
      { provisionAndAttach: vi.fn() } as unknown as WorktreeProvisioner,
      { onBlockerResolved: vi.fn().mockResolvedValue(undefined) } as unknown as JobDependencyService,
      { failRunningForJob: vi.fn().mockResolvedValue(0) } as unknown as TurnRegistry,
      { get: vi.fn() } as unknown as ModuleRef,
      { wakeForProvisioningFailure: vi.fn() } as unknown as BrainGateway,
      { reconcileOrgAsync: vi.fn() } as unknown as SkillUpdaterService,
      { neutralizeMergeCard: vi.fn().mockResolvedValue(undefined) } as unknown as DriverStoreService,
    );
    return { svc, getPullState };
  }

  it('pollPrClosures SKIPS a job whose pr_state is already terminal (a detached merged job) — no re-poll, no re-count', async () => {
    const { svc, getPullState } = makeServiceForPoll(
      { pr_state: 'merged' },
      makeRow({ lifecycle: 'detached' }),
    );
    const closed = await svc.pollPrClosures();
    expect(getPullState).not.toHaveBeenCalled(); // already handled — don't re-observe
    expect(closed).toBe(0);
  });

  it('pollPrClosures STILL observes a job whose PR is open (pr_state open) — the first terminal transition', async () => {
    const { svc, getPullState } = makeServiceForPoll(
      { pr_state: 'open' },
      makeRow({ lifecycle: 'attached' }),
    );
    await svc.pollPrClosures();
    expect(getPullState).toHaveBeenCalledTimes(1);
  });

  // ── reapMergedSandboxes: reclaim disk (worktree + scratch) for long-detached terminal jobs ──────────
  function makeServiceForGc(jobs: Array<{ id: string; org_id: string }>, sandboxByJob: Record<string, JobSandboxEntity | null>) {
    const svc = new JobLifecycleService(
      { find: vi.fn().mockResolvedValue(jobs) } as unknown as Repository<JobEntity>,
      {
        findOne: vi.fn(async ({ where }: { where: { job_id: string } }) => sandboxByJob[where.job_id] ?? null),
      } as unknown as Repository<JobSandboxEntity>,
      { findOne: vi.fn() } as unknown as Repository<RepoEntity>,
      {} as unknown as LocalGitService,
      { getPullState: vi.fn() } as unknown as GithubPrService,
      { githubToken: vi.fn() } as unknown as CredentialResolver,
      { get: vi.fn() } as unknown as EnvService,
      new SandboxActivityRegistry(),
      { resolve: vi.fn() } as unknown as DriverRepoResolver,
      { attach: vi.fn(), teardown: vi.fn(), teardownByIdentity: vi.fn() } as unknown as SandboxProvider,
      { provisionAndAttach: vi.fn() } as unknown as WorktreeProvisioner,
      { onBlockerResolved: vi.fn().mockResolvedValue(undefined) } as unknown as JobDependencyService,
      { failRunningForJob: vi.fn().mockResolvedValue(0) } as unknown as TurnRegistry,
      { get: vi.fn() } as unknown as ModuleRef,
      { wakeForProvisioningFailure: vi.fn() } as unknown as BrainGateway,
      { reconcileOrgAsync: vi.fn() } as unknown as SkillUpdaterService,
      { neutralizeMergeCard: vi.fn().mockResolvedValue(undefined) } as unknown as DriverStoreService,
    );
    // Spy the two reclaim effects on the instance — we assert the DECISION, not closeJob/rmSync internals.
    const closeJob = vi.fn().mockResolvedValue(undefined);
    const removeScratch = vi.fn();
    svc.closeJob = closeJob;
    (svc as unknown as { removeJobScratchDirs: (o: string, j: string) => void }).removeJobScratchDirs = removeScratch;
    return { svc, closeJob, removeScratch };
  }

  const DAY = 24 * 60 * 60 * 1000;

  it('reapMergedSandboxes reclaims a detached + past-TTL row (worktree + scratch), leaving recent / attached / others alone', async () => {
    const old = new Date(Date.now() - 8 * DAY); // past the 7-day TTL
    const fresh = new Date();
    const { svc, closeJob, removeScratch } = makeServiceForGc(
      [
        { id: 'stale', org_id: 'T1' },
        { id: 'recent', org_id: 'T1' },
        { id: 'attached', org_id: 'T1' },
      ],
      {
        stale: makeRow({ job_id: 'stale', lifecycle: 'detached', updated_at: old }),
        recent: makeRow({ job_id: 'recent', lifecycle: 'detached', updated_at: fresh }),
        attached: makeRow({ job_id: 'attached', lifecycle: 'attached', updated_at: old }),
      },
    );

    const n = await svc.reapMergedSandboxes();

    expect(n).toBe(1);
    expect(closeJob).toHaveBeenCalledTimes(1);
    expect(closeJob).toHaveBeenCalledWith('stale', 'T1'); // worktree + container reclaimed
    expect(removeScratch).toHaveBeenCalledWith('T1', 'stale'); // /context + /playground reclaimed too
  });
});
