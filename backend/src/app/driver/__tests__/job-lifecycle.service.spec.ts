
import type { EnvService } from '@core/config/env/env.service';
import type { ModuleRef } from '@nestjs/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { GithubPrService, LocalGitService } from '../../git';
import type { JobDependencyService } from '../../job-deps';
import type { CredentialResolver } from '../../onboarding';
import type { JobEntity, JobSandboxEntity, RepoEntity } from '../../persistence/entities';
import { SandboxActivityRegistry, type SandboxProvider } from '../../sandbox';
import { TurnRegistry } from '../../sandbox/turn-registry.service';
import type { SkillUpdaterService } from '../../skills/skill-updater.service';
import type { BrainGateway } from '../brain-gateway';
import type { DriverStoreService } from '../driver-store.service';
import { JobLifecycleService } from '../job-lifecycle.service';
import type { DriverRepoResolver } from '../repo-resolver';
import type { WorktreeProvisioner } from '../worktree-provisioner.service';


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

function makeService(
  thread: Partial<JobEntity> = {},
  repo: Partial<RepoEntity> = {},
): JobLifecycleService {
  const threadRow = {
    id: 'thread-1',
    feature_branch: null,
    base_branch: 'main',
    ...thread,
  };
  const repoRow = {
    id: 'repo-uuid-1',
    slug: 'proj',
    default_branch: 'main',
    ...repo,
  };
  const threads = {
    findOne: vi.fn().mockResolvedValue(threadRow),
  } as unknown as Repository<JobEntity>;
  const projects = {
    findOne: vi.fn().mockResolvedValue(repoRow),
  } as unknown as Repository<RepoEntity>;
  const sandboxes = {
    findOne: vi.fn(),
    save: vi.fn(),
    create: vi.fn(),
  } as unknown as Repository<JobSandboxEntity>;

  return new JobLifecycleService(
    threads,
    sandboxes,
    projects,
    {} as unknown as LocalGitService,
    { getPullState: vi.fn() } as unknown as GithubPrService,
    {
      githubToken: vi.fn(),
      hostGithubToken: vi.fn(),
    } as unknown as CredentialResolver,
    { get: vi.fn() } as unknown as EnvService,
    new SandboxActivityRegistry(),
    { resolve: vi.fn() } as unknown as DriverRepoResolver,
    {
      attach: vi.fn(),
      teardown: vi.fn(),
      teardownByIdentity: vi.fn(),
    } as unknown as SandboxProvider,
    { provisionAndAttach: vi.fn() } as unknown as WorktreeProvisioner,
    {
      onBlockerResolved: vi.fn().mockResolvedValue(undefined),
    } as unknown as JobDependencyService,
    {
      failRunningForJob: vi.fn().mockResolvedValue(0),
    } as unknown as TurnRegistry,
    { get: vi.fn() } as unknown as ModuleRef,
    { wakeForProvisioningFailure: vi.fn() } as unknown as BrainGateway,
    { reconcileOrgAsync: vi.fn() } as unknown as SkillUpdaterService,
    {
      neutralizeMergeCard: vi.fn().mockResolvedValue(undefined),
    } as unknown as DriverStoreService,
  );
}

function makeServiceWithMocks(
  row: JobSandboxEntity | null,
  hydrationSig = 'new',
  sandboxExtra: Partial<import('../../git').FeatureSandbox> = {},
) {
  const sandboxes = {
    findOne: vi.fn().mockResolvedValue(row),
    save: vi.fn(),
    create: vi.fn(),
  } as unknown as Repository<JobSandboxEntity>;
  const provisionAndAttach = vi.fn().mockResolvedValue({
    sandbox: {
      worktreePath: row?.worktree_path,
      containerId: 'c1',
      repoId: 'proj',
      branch: 'main',
      ...sandboxExtra,
    },
    hydrationSig,
  });
  const svc = new JobLifecycleService(
    {
      findOne: vi.fn().mockResolvedValue({
        id: 'thread-1',
        feature_branch: null,
        base_branch: 'main',
      }),
    } as unknown as Repository<JobEntity>,
    sandboxes,
    {
      findOne: vi.fn().mockResolvedValue({
        id: 'repo-uuid-1',
        slug: 'proj',
        default_branch: 'main',
      }),
    } as unknown as Repository<RepoEntity>,
    {} as unknown as LocalGitService,
    { getPullState: vi.fn() } as unknown as GithubPrService,
    {
      githubToken: vi.fn(),
      hostGithubToken: vi.fn(),
    } as unknown as CredentialResolver,
    { get: vi.fn() } as unknown as EnvService,
    new SandboxActivityRegistry(),
    { resolve: vi.fn() } as unknown as DriverRepoResolver,
    {
      attach: vi.fn(),
      teardown: vi.fn(),
      teardownByIdentity: vi.fn(),
    } as unknown as SandboxProvider,
    { provisionAndAttach } as unknown as WorktreeProvisioner,
    {
      onBlockerResolved: vi.fn().mockResolvedValue(undefined),
    } as unknown as JobDependencyService,
    {
      failRunningForJob: vi.fn().mockResolvedValue(0),
    } as unknown as TurnRegistry,
    { get: vi.fn() } as unknown as ModuleRef,
    { wakeForProvisioningFailure: vi.fn() } as unknown as BrainGateway,
    { reconcileOrgAsync: vi.fn() } as unknown as SkillUpdaterService,
    {
      neutralizeMergeCard: vi.fn().mockResolvedValue(undefined),
    } as unknown as DriverStoreService,
  );
  return { svc, sandboxes, provisionAndAttach };
}

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
    {
      findOne: vi.fn().mockResolvedValue({
        id: 'repo-uuid-1',
        slug: 'proj',
        default_branch: 'main',
      }),
    } as unknown as Repository<RepoEntity>,
    {} as unknown as LocalGitService,
    { getPullState: vi.fn() } as unknown as GithubPrService,
    {
      githubToken: vi.fn(),
      hostGithubToken: vi.fn(),
    } as unknown as CredentialResolver,
    { get: vi.fn() } as unknown as EnvService,
    activity,
    { resolve: vi.fn() } as unknown as DriverRepoResolver,
    {
      attach: vi.fn(),
      teardown,
      teardownByIdentity: vi.fn(),
    } as unknown as SandboxProvider,
    { provisionAndAttach: vi.fn() } as unknown as WorktreeProvisioner,
    {
      onBlockerResolved: vi.fn().mockResolvedValue(undefined),
    } as unknown as JobDependencyService,
    { failRunningForJob } as unknown as TurnRegistry,
    { get: vi.fn() } as unknown as ModuleRef,
    { wakeForProvisioningFailure: vi.fn() } as unknown as BrainGateway,
    { reconcileOrgAsync: vi.fn() } as unknown as SkillUpdaterService,
    {
      neutralizeMergeCard: vi.fn().mockResolvedValue(undefined),
    } as unknown as DriverStoreService,
  );
  return { svc, sandboxes, teardown, activity, failRunningForJob };
}

function rowToSandbox(svc: JobLifecycleService, row: JobSandboxEntity) {
  return (
    svc as unknown as {
      rowToSandbox(r: JobSandboxEntity): Promise<import('../../git').FeatureSandbox>;
    }
  ).rowToSandbox(row);
}


describe('JobLifecycleService.rowToSandbox', () => {
  it('populates execUser with the host uid:gid for a row WITH a container_id (docker mode)', async () => {
    const svc = makeService();
    const row = makeRow({ container_id: 'abc123def456' });

    const sandbox = await rowToSandbox(svc, row);

    expect(sandbox).toMatchObject({ containerId: 'abc123def456' });

    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;

    if (uid !== undefined && gid !== undefined) {
      expect(sandbox.execUser).toBe(`${uid}:${gid}`);
    } else {
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
      const row = makeRow({
        worktree_path: wt,
        hydration_sig: 'old',
      } as Partial<JobSandboxEntity>);
      const { svc, sandboxes, provisionAndAttach } = makeServiceWithMocks(row, 'new-sig');

      const ok = await svc.rehydrateThread('thread-1', 'T1');

      expect(ok).toBe(true);
      expect(provisionAndAttach).toHaveBeenCalledWith(
        expect.objectContaining({
          forceHydrate: true,
          jobId: 'thread-1',
          orgId: 'T1',
        }),
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
    const row = makeRow({
      container_id: 'c-live',
      worktree_path: '/wt/keep',
      session_id: 'sess-keep',
    });
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

    expect(failRunningForJob).toHaveBeenCalledWith('thread-1');
  });

  it('returns no-container (no teardown) when the row has no live container', async () => {
    const { svc, teardown } = makeServiceForReset(makeRow({ container_id: null }));
    expect(await svc.resetContainer('thread-1', 'T1')).toEqual({
      reset: false,
      reason: 'no-container',
    });
    expect(teardown).not.toHaveBeenCalled();
  });

  it('returns no-container when there is no sandbox row', async () => {
    const { svc } = makeServiceForReset(null);
    expect(await svc.resetContainer('thread-1', 'T1')).toEqual({
      reset: false,
      reason: 'no-container',
    });
  });

  it('refuses (busy) — never tears down a container with a turn/build executing in it', async () => {
    const row = makeRow({ container_id: 'c-busy' });
    const { svc, teardown, activity } = makeServiceForReset(row);
    activity.enter('c-busy'); // a driver build/turn is live on this container right now

    expect(await svc.resetContainer('thread-1', 'T1')).toEqual({
      reset: false,
      reason: 'busy',
    });
    expect(teardown).not.toHaveBeenCalled();
    expect(row.lifecycle).toBe('attached'); // untouched
  });
});

describe('JobLifecycleService.reapIdle', () => {
  it('does not reap a sandbox while the durable job activity is non-idle', async () => {
    const row = makeRow({
      container_id: 'c-review',
      last_active_at: new Date(0),
    });
    const { svc, teardown } = makeServiceForReset(row, 'plan_review');

    expect(await svc.reapIdle()).toBe(0);
    expect(teardown).not.toHaveBeenCalled();
    expect(row.lifecycle).toBe('attached');
  });

  it('reaps an old attached sandbox once the durable job activity is idle', async () => {
    const row = makeRow({
      container_id: 'c-idle',
      last_active_at: new Date(0),
    });
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

      const saved = (
        sandboxes.save as unknown as { mock: { calls: JobSandboxEntity[][] } }
      ).mock.calls.at(-1)![0];
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

      const saved = (
        sandboxes.save as unknown as { mock: { calls: JobSandboxEntity[][] } }
      ).mock.calls.at(-1)![0];
      expect(saved.setup_error).toBeNull();
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe('JobLifecycleService.applyGithubPrState', () => {
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
      {
        findOne: vi.fn(),
        save: vi.fn(),
        create: vi.fn(),
      } as unknown as Repository<JobSandboxEntity>,
      { findOne: vi.fn() } as unknown as Repository<RepoEntity>,
      {} as unknown as LocalGitService,
      { getPullState: vi.fn() } as unknown as GithubPrService,
      {
        githubToken: vi.fn(),
        hostGithubToken: vi.fn(),
      } as unknown as CredentialResolver,
      { get: vi.fn() } as unknown as EnvService,
      new SandboxActivityRegistry(),
      { resolve: vi.fn() } as unknown as DriverRepoResolver,
      {
        attach: vi.fn(),
        teardown: vi.fn(),
        teardownByIdentity: vi.fn(),
      } as unknown as SandboxProvider,
      { provisionAndAttach: vi.fn() } as unknown as WorktreeProvisioner,
      {
        onBlockerResolved: vi.fn().mockResolvedValue(undefined),
      } as unknown as JobDependencyService,
      {
        failRunningForJob: vi.fn().mockResolvedValue(0),
      } as unknown as TurnRegistry,
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

  it("state='merged' writes pr_state=merged but NO LONGER tears anything down (decision d5 — merged stays interactive)", async () => {
    const { svc, jobs, order, neutralizeMergeCard } = makeServiceForApply();
    const result = await svc.applyGithubPrState(job, 'merged');
    expect(result).toBe('noop');
    expect(jobs.update).toHaveBeenCalledWith({ id: 'job-1' }, { pr_state: 'merged' });
    expect(order).toEqual(['update:merged']);
    expect(svc.detachJobContainer).not.toHaveBeenCalled();
    expect(neutralizeMergeCard).toHaveBeenCalledWith('job-1', 'merged');
  });

  it("state='closed' writes pr_state=closed, no teardown", async () => {
    const { svc, jobs, order, neutralizeMergeCard } = makeServiceForApply();
    const result = await svc.applyGithubPrState(job, 'closed');
    expect(result).toBe('noop');
    expect(jobs.update).toHaveBeenCalledWith({ id: 'job-1' }, { pr_state: 'closed' });
    expect(order).toEqual(['update:closed']);
    expect(svc.detachJobContainer).not.toHaveBeenCalled();
    expect(neutralizeMergeCard).toHaveBeenCalledWith('job-1', 'not-ready');
  });

  it("state='gone' folds to pr_state=closed, no teardown", async () => {
    const { svc, jobs, order } = makeServiceForApply();
    const result = await svc.applyGithubPrState(job, 'gone');
    expect(result).toBe('noop');
    expect(jobs.update).toHaveBeenCalledWith({ id: 'job-1' }, { pr_state: 'closed' });
    expect(order).toEqual(['update:closed']);
    expect(svc.detachJobContainer).not.toHaveBeenCalled();
  });
});

describe('JobLifecycleService.closeJobPullRequest', () => {
  function makeServiceForClose(repo: Partial<RepoEntity> | null) {
    const projects = {
      findOne: vi.fn().mockResolvedValue(repo),
    } as unknown as Repository<RepoEntity>;
    const closePullRequest = vi.fn().mockResolvedValue(undefined);
    const hostGithubToken = vi.fn().mockResolvedValue('TOK');
    const svc = new JobLifecycleService(
      { findOne: vi.fn() } as unknown as Repository<JobEntity>,
      {
        findOne: vi.fn(),
        save: vi.fn(),
        create: vi.fn(),
      } as unknown as Repository<JobSandboxEntity>,
      projects,
      {} as unknown as LocalGitService,
      { closePullRequest } as unknown as GithubPrService,
      { hostGithubToken } as unknown as CredentialResolver,
      { get: vi.fn() } as unknown as EnvService,
      new SandboxActivityRegistry(),
      { resolve: vi.fn() } as unknown as DriverRepoResolver,
      {
        attach: vi.fn(),
        teardown: vi.fn(),
        teardownByIdentity: vi.fn(),
      } as unknown as SandboxProvider,
      { provisionAndAttach: vi.fn() } as unknown as WorktreeProvisioner,
      {
        onBlockerResolved: vi.fn().mockResolvedValue(undefined),
      } as unknown as JobDependencyService,
      {
        failRunningForJob: vi.fn().mockResolvedValue(0),
      } as unknown as TurnRegistry,
      { get: vi.fn() } as unknown as ModuleRef,
      { wakeForProvisioningFailure: vi.fn() } as unknown as BrainGateway,
      { reconcileOrgAsync: vi.fn() } as unknown as SkillUpdaterService,
      {
        neutralizeMergeCard: vi.fn().mockResolvedValue(undefined),
      } as unknown as DriverStoreService,
    );
    return { svc, projects, closePullRequest, hostGithubToken };
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
    const { svc, projects, closePullRequest, hostGithubToken } = makeServiceForClose({
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

    expect(projects.findOne).toHaveBeenCalledWith({
      where: { id: 'repo-1', org_id: 'T1' },
    });
    expect(hostGithubToken).toHaveBeenCalledWith('T1');
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
      {
        findOne: vi.fn().mockResolvedValue({
          id: 'thread-1',
          feature_branch: 'atlas/f',
          base_branch: 'main',
        }),
      } as unknown as Repository<JobEntity>,
      sandboxes,
      {
        findOne: vi.fn().mockResolvedValue({
          id: 'repo-uuid-1',
          slug: 'proj',
          default_branch: 'main',
          git_url: 'https://github.com/a/b',
        }),
      } as unknown as Repository<RepoEntity>,
      { removeSandbox } as unknown as LocalGitService,
      { getPullState: vi.fn() } as unknown as GithubPrService,
      {
        githubToken: vi.fn(),
        hostGithubToken: vi.fn(),
      } as unknown as CredentialResolver,
      { get: vi.fn() } as unknown as EnvService,
      new SandboxActivityRegistry(),
      { resolve: vi.fn() } as unknown as DriverRepoResolver,
      {
        attach: vi.fn(),
        teardown: vi.fn(),
        teardownByIdentity,
      } as unknown as SandboxProvider,
      { provisionAndAttach: vi.fn() } as unknown as WorktreeProvisioner,
      {
        onBlockerResolved: vi.fn().mockResolvedValue(undefined),
      } as unknown as JobDependencyService,
      {
        failRunningForJob: vi.fn().mockResolvedValue(0),
      } as unknown as TurnRegistry,
      { get: vi.fn() } as unknown as ModuleRef,
      { wakeForProvisioningFailure: vi.fn() } as unknown as BrainGateway,
      { reconcileOrgAsync: vi.fn() } as unknown as SkillUpdaterService,
      {
        neutralizeMergeCard: vi.fn().mockResolvedValue(undefined),
      } as unknown as DriverStoreService,
    );
    return { svc, sandboxes, update, teardownByIdentity, removeSandbox };
  }

  it('detachJobContainer frees the container (by identity) + marks detached, but KEEPS the worktree + session', async () => {
    const row = makeRow({
      lifecycle: 'attached',
      container_id: 'c1',
      worktree_path: '/wt',
      session_id: 'sess-1',
    });
    const { svc, update, teardownByIdentity, removeSandbox } = makeServiceForDetach(row);

    await svc.detachJobContainer('thread-1', 'T1');

    expect(teardownByIdentity).toHaveBeenCalledTimes(1); // container reclaimed by deterministic name
    expect(removeSandbox).not.toHaveBeenCalled(); // worktree KEPT (the whole point — resume needs it)
    expect(update).toHaveBeenCalledWith(
      { id: row.id },
      { container_id: null, lifecycle: 'detached' },
    );
  });

  it('detachJobContainer still tears down a boot-reconciled DETACHED row (container_id null but real container may run)', async () => {
    const row = makeRow({
      lifecycle: 'detached',
      container_id: null,
      worktree_path: '/wt',
    });
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
    const row = makeRow({
      lifecycle: 'detached',
      worktree_path: '/wt/thread-1',
      session_id: 'sess-1',
    });
    const svc = new JobLifecycleService(
      {
        findOne: vi.fn().mockResolvedValue({
          id: 'thread-1',
          feature_branch: 'atlas/f',
          base_branch: 'main',
        }),
      } as unknown as Repository<JobEntity>,
      {
        findOne: vi.fn().mockResolvedValue(row),
        update: vi.fn(),
        save: vi.fn(),
        create: vi.fn(),
      } as unknown as Repository<JobSandboxEntity>,
      {
        findOne: vi.fn().mockResolvedValue({
          id: 'repo-uuid-1',
          slug: 'proj',
          default_branch: 'main',
        }),
      } as unknown as Repository<RepoEntity>,
      {} as unknown as LocalGitService,
      { getPullState: vi.fn() } as unknown as GithubPrService,
      {
        githubToken: vi.fn(),
        hostGithubToken: vi.fn(),
      } as unknown as CredentialResolver,
      { get: vi.fn() } as unknown as EnvService,
      new SandboxActivityRegistry(),
      { resolve: vi.fn() } as unknown as DriverRepoResolver,
      {
        attach: vi.fn(),
        teardown: vi.fn(),
        teardownByIdentity: vi.fn(),
      } as unknown as SandboxProvider,
      { provisionAndAttach: vi.fn() } as unknown as WorktreeProvisioner,
      {
        onBlockerResolved: vi.fn().mockResolvedValue(undefined),
      } as unknown as JobDependencyService,
      {
        failRunningForJob: vi.fn().mockResolvedValue(0),
      } as unknown as TurnRegistry,
      { get: vi.fn() } as unknown as ModuleRef,
      { wakeForProvisioningFailure: vi.fn() } as unknown as BrainGateway,
      { reconcileOrgAsync: vi.fn() } as unknown as SkillUpdaterService,
      {
        neutralizeMergeCard: vi.fn().mockResolvedValue(undefined),
      } as unknown as DriverStoreService,
    );

    const out = await svc.ensureProvisioned('thread-1', 'T1');
    expect(out).toBe(row); // resumable — contrast the 'closed' → null gate
  });

  function makeServiceForPoll(
    job: Partial<JobEntity>,
    sandbox: JobSandboxEntity | null,
    pullState: 'open' | 'merged' | 'closed' = 'open',
  ) {
    const getPullState = vi.fn().mockResolvedValue(pullState);
    const svc = new JobLifecycleService(
      {
        find: vi.fn().mockResolvedValue([
          {
            id: 'thread-1',
            org_id: 'T1',
            repo_id: 'repo-1',
            pr_number: 5,
            ...job,
          },
        ]),
        update: vi.fn().mockResolvedValue({ affected: 1 }),
      } as unknown as Repository<JobEntity>,
      {
        findOne: vi.fn().mockResolvedValue(sandbox),
      } as unknown as Repository<JobSandboxEntity>,
      {
        findOne: vi.fn().mockResolvedValue({
          id: 'repo-1',
          git_url: 'https://github.com/a/b',
        }),
      } as unknown as Repository<RepoEntity>,
      {} as unknown as LocalGitService,
      { getPullState } as unknown as GithubPrService,
      {
        hostGithubToken: vi.fn().mockResolvedValue('ghtok'),
      } as unknown as CredentialResolver,
      { get: vi.fn() } as unknown as EnvService,
      new SandboxActivityRegistry(),
      { resolve: vi.fn() } as unknown as DriverRepoResolver,
      {
        attach: vi.fn(),
        teardown: vi.fn(),
        teardownByIdentity: vi.fn(),
      } as unknown as SandboxProvider,
      { provisionAndAttach: vi.fn() } as unknown as WorktreeProvisioner,
      {
        onBlockerResolved: vi.fn().mockResolvedValue(undefined),
      } as unknown as JobDependencyService,
      {
        failRunningForJob: vi.fn().mockResolvedValue(0),
      } as unknown as TurnRegistry,
      { get: vi.fn() } as unknown as ModuleRef,
      { wakeForProvisioningFailure: vi.fn() } as unknown as BrainGateway,
      { reconcileOrgAsync: vi.fn() } as unknown as SkillUpdaterService,
      {
        neutralizeMergeCard: vi.fn().mockResolvedValue(undefined),
      } as unknown as DriverStoreService,
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
});

describe('JobLifecycleService — archive lifecycle', () => {
  function makeArchiveService(
    opts: {
      updateAffected?: number[];
      eligible?: Array<{ id: string; org_id: string }>;
      row?: JobSandboxEntity | null;
    } = {},
  ) {
    const affectedQueue = [...(opts.updateAffected ?? [])];
    const update = vi.fn(async (_where: unknown, _patch: unknown) => ({
      affected: affectedQueue.length ? affectedQueue.shift() : 1,
    }));
    const predicates: string[] = [];
    const qb = {
      select: vi.fn(() => qb),
      where: vi.fn((clause: string) => {
        predicates.push(clause);
        return qb;
      }),
      andWhere: vi.fn((clause: string) => {
        predicates.push(clause);
        return qb;
      }),
      innerJoin: vi.fn(() => qb),
      getMany: vi.fn(async () => opts.eligible ?? []),
    };
    const jobs = {
      update,
      createQueryBuilder: vi.fn(() => qb),
      findOne: vi.fn().mockResolvedValue({
        id: 'job-1',
        feature_branch: 'atlas/f',
        base_branch: 'main',
      }),
    } as unknown as Repository<JobEntity>;

    const sandboxUpdate = vi.fn().mockResolvedValue({ affected: 1 });
    const sandboxes = {
      findOne: vi.fn().mockResolvedValue(opts.row === undefined ? null : opts.row),
      update: sandboxUpdate,
      save: vi.fn(),
      create: vi.fn(),
    } as unknown as Repository<JobSandboxEntity>;

    const removeSandbox = vi.fn().mockResolvedValue(undefined);
    const ensureRepo = vi.fn().mockResolvedValue({ localPath: '/repos/proj' });
    const teardownByIdentity = vi.fn().mockResolvedValue(undefined);
    const onBlockerResolved = vi.fn().mockResolvedValue(undefined);
    const playgroundDirHost = vi.fn(() => '/pg');
    const contextDirHost = vi.fn(() => '/ctx');
    const brainTranscriptProjectsDir = vi.fn(() => null);
    const projectsUpdate = vi.fn().mockResolvedValue({ affected: 1 });

    const svc = new JobLifecycleService(
      jobs,
      sandboxes,
      {
        findOne: vi.fn().mockResolvedValue({
          id: 'repo-uuid-1',
          slug: 'proj',
          default_branch: 'main',
          git_url: 'https://github.com/a/b',
        }),
        update: projectsUpdate,
      } as unknown as Repository<RepoEntity>,
      { removeSandbox, ensureRepo } as unknown as LocalGitService,
      { getPullState: vi.fn() } as unknown as GithubPrService,
      {
        githubToken: vi.fn(),
        hostGithubToken: vi.fn().mockResolvedValue('tok'),
      } as unknown as CredentialResolver,
      { get: vi.fn() } as unknown as EnvService,
      new SandboxActivityRegistry(),
      { resolve: vi.fn() } as unknown as DriverRepoResolver,
      {
        attach: vi.fn(),
        teardown: vi.fn(),
        teardownByIdentity,
        playgroundDirHost,
        contextDirHost,
        draftUploadsDirHost: vi.fn((o: string, j: string, u: string) => `/draft/${o}/${j}/${u}`),
        brainTranscriptProjectsDir,
      } as unknown as SandboxProvider,
      { provisionAndAttach: vi.fn() } as unknown as WorktreeProvisioner,
      { onBlockerResolved } as unknown as JobDependencyService,
      {
        failRunningForJob: vi.fn().mockResolvedValue(0),
      } as unknown as TurnRegistry,
      { get: vi.fn() } as unknown as ModuleRef,
      { wakeForProvisioningFailure: vi.fn() } as unknown as BrainGateway,
      { reconcileOrgAsync: vi.fn() } as unknown as SkillUpdaterService,
      {
        neutralizeMergeCard: vi.fn().mockResolvedValue(undefined),
      } as unknown as DriverStoreService,
    );
    return {
      svc,
      update,
      sandboxUpdate,
      predicates,
      teardownByIdentity,
      removeSandbox,
      onBlockerResolved,
      playgroundDirHost,
      contextDirHost,
      brainTranscriptProjectsDir,
    };
  }

  it('claimArchiveJob is single-flight — the first claim wins, a concurrent second matches 0 rows', async () => {
    const { svc, update } = makeArchiveService({ updateAffected: [1, 0] });
    expect(await svc.claimArchiveJob('job-1', 'T1')).toBe(true);
    expect(await svc.claimArchiveJob('job-1', 'T1')).toBe(false);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-1', org_id: 'T1' }),
      expect.objectContaining({ status: 'archived' }),
    );
    const patch = update.mock.calls[0]![1] as { archived_at?: Date };
    expect(patch.archived_at).toBeInstanceOf(Date);
  });

  it('archiveJobDeep reclaims container+worktree + /playground + JSONL and wakes dependents, but KEEPS /context (decision d2)', async () => {
    const { svc, onBlockerResolved } = makeArchiveService();
    const reclaim = vi.fn().mockResolvedValue(true);
    const removePlayground = vi.fn();
    const removeDraftUploads = vi.fn();
    const removeContext = vi.fn();
    const removeJsonl = vi.fn();
    svc.reclaimJobArtifacts = reclaim;
    (
      svc as unknown as {
        removeJobPlaygroundDir: (o: string, j: string) => void;
      }
    ).removeJobPlaygroundDir = removePlayground;
    (
      svc as unknown as {
        removeJobDraftUploadsDir: (o: string, j: string) => void;
      }
    ).removeJobDraftUploadsDir = removeDraftUploads;
    (
      svc as unknown as { removeJobContextDir: (o: string, j: string) => void }
    ).removeJobContextDir = removeContext;
    (svc as unknown as { removeOnDiskSessionJsonl: (j: string) => void }).removeOnDiskSessionJsonl =
      removeJsonl;

    await svc.archiveJobDeep('job-1', 'T1');

    expect(reclaim).toHaveBeenCalledWith('job-1', 'T1');
    expect(removePlayground).toHaveBeenCalledWith('T1', 'job-1');
    expect(removeDraftUploads).toHaveBeenCalledWith('T1', 'job-1'); // staged draft uploads reclaimed
    expect(removeContext).not.toHaveBeenCalled(); // /context is RETAINED on archive
    expect(removeJsonl).toHaveBeenCalledWith('job-1');
    expect(onBlockerResolved).toHaveBeenCalledWith('job-1', 'archived');
  });

  it('reclaimJobArtifacts marks the sandbox closed when the worktree is genuinely gone', async () => {
    const { svc, sandboxUpdate, teardownByIdentity } = makeArchiveService({
      row: makeRow({
        lifecycle: 'detached',
        worktree_path: '/definitely/gone',
      }),
    });
    expect(await svc.reclaimJobArtifacts('job-1', 'T1')).toBe(true);
    expect(teardownByIdentity).toHaveBeenCalledTimes(1);
    expect(sandboxUpdate).toHaveBeenCalledWith(
      { id: 'sandbox-1' },
      { container_id: null, lifecycle: 'closed' },
    );
  });

  it('reclaimJobArtifacts returns false and does NOT mark closed when the worktree dir survives removal (swallowed failure)', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'atlas-arch-'));
    try {
      const { svc, sandboxUpdate } = makeArchiveService({
        row: makeRow({ lifecycle: 'detached', worktree_path: wt }),
      });
      expect(await svc.reclaimJobArtifacts('job-1', 'T1')).toBe(false);
      expect(sandboxUpdate).not.toHaveBeenCalled(); // lifecycle stays non-closed → reconciler retries
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it('reclaimJobArtifacts is a no-op (true) for an already-closed sandbox (nothing owed)', async () => {
    const { svc, teardownByIdentity, sandboxUpdate } = makeArchiveService({
      row: makeRow({ lifecycle: 'closed' }),
    });
    expect(await svc.reclaimJobArtifacts('job-1', 'T1')).toBe(true);
    expect(teardownByIdentity).not.toHaveBeenCalled();
    expect(sandboxUpdate).not.toHaveBeenCalled();
  });

  it('archiveInactiveJobs claims + archives every eligible job and returns the count; the query anchors on last transcript activity', async () => {
    const { svc, predicates } = makeArchiveService({
      eligible: [
        { id: 'a', org_id: 'T1' },
        { id: 'b', org_id: 'T2' },
      ],
    });
    const claim = vi.fn().mockResolvedValue(true);
    const deep = vi.fn().mockResolvedValue(undefined);
    svc.claimArchiveJob = claim;
    svc.archiveJobDeep = deep;

    const n = await svc.archiveInactiveJobs();

    expect(n).toBe(2);
    expect(claim).toHaveBeenCalledWith('a', 'T1');
    expect(deep).toHaveBeenCalledWith('a', 'T1');
    expect(claim).toHaveBeenCalledWith('b', 'T2');
    const sql = predicates.join(' ');
    expect(sql).toContain('status NOT IN');
    expect(sql).toContain('pr_state IN');
    expect(sql).toContain('MAX(m.created_at)');
    expect(sql).toContain('< :cutoff');
  });

  it('archiveInactiveJobs skips a job it loses the archive claim for (archived concurrently)', async () => {
    const { svc } = makeArchiveService({
      eligible: [{ id: 'a', org_id: 'T1' }],
    });
    svc.claimArchiveJob = vi.fn().mockResolvedValue(false);
    const deep = vi.fn().mockResolvedValue(undefined);
    svc.archiveJobDeep = deep;
    expect(await svc.archiveInactiveJobs()).toBe(0);
    expect(deep).not.toHaveBeenCalled();
  });

  it('reconcileArchivedSandboxes re-runs the idempotent archiveJobDeep for each archived job still not fully closed', async () => {
    const { svc } = makeArchiveService({
      eligible: [{ id: 'x', org_id: 'T1' }],
    });
    const deep = vi.fn().mockResolvedValue(undefined);
    svc.archiveJobDeep = deep;
    expect(await svc.reconcileArchivedSandboxes()).toBe(1);
    expect(deep).toHaveBeenCalledWith('x', 'T1');
  });
});
