import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { existsSync, rmSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { In, IsNull, Not, Repository } from 'typeorm';
import { BrainGateway } from '../brain-gateway/brain-gateway.service';
import { GithubPrService, parseGithubRepoUrl } from '../git/github-pr.service';
import { FeatureSandbox, LocalGitService, ProjectRepo } from '../git/local-git.service';
import { JobBootstrapService } from '../job-bootstrap/job-bootstrap.service';
import { JobDependencyService } from '../job-deps/job-dependency.service';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import { OnboardingService } from '../onboarding/onboarding.service';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity, JobSandboxEntity, RepoEntity } from '../persistence/entities';
import { hostExecUser } from '../sandbox/host-exec-user';
import { SandboxActivityRegistry } from '../sandbox/sandbox-activity.registry';
import {
  SANDBOX_PROVIDER,
  SandboxMilestoneStage,
  type SandboxProvider,
  ServiceLivenessProbe,
} from '../sandbox/sandbox-provider.port';
import { TurnRegistry } from '../sandbox/turn-registry.service';
import { SkillUpdaterService } from '../skills/skill-updater.service';
import { computeFeatureBranchName } from './branch-naming';
import { DriverStoreService } from './driver-store.service';
import { DRIVER_REPO, type DriverRepoResolver } from './repo-resolver';
import { WorktreeProvisioner } from './worktree-provisioner.service';

const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;

export type ThreadSandboxLifecycle = 'provisioning' | 'attached' | 'detached' | 'closed';

export interface CreateThreadInput {
  orgId: string;
  repoId: string;
  repoUrl?: string;
  baseBranch?: string;
  displayName?: string;
}

export interface CreatedThread {
  jobId: string;
  threadSandboxId: string;
  worktreePath: string;
  baseBranch: string;
}

export class ProvisioningNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisioningNotReadyError';
  }
}

function setupErrorFrom(sandbox: FeatureSandbox): string | null {
  const r = sandbox.setupScriptResult;
  return r && !r.ok ? `exit ${r.exitCode}: ${r.tail}` : null;
}

const DEFAULT_ARCHIVE_INACTIVITY_TTL_MS = 3 * 24 * 60 * 60 * 1000;

@Injectable()
export class JobLifecycleService {
  private readonly logger = new Logger(JobLifecycleService.name);

  private readonly provisioning = new Map<string, Promise<JobSandboxEntity | null>>();

  constructor(
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
    @InjectRepository(JobSandboxEntity, DB_CONNECTION)
    private readonly sandboxes: Repository<JobSandboxEntity>,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly projects: Repository<RepoEntity>,
    private readonly git: LocalGitService,
    private readonly pr: GithubPrService,
    private readonly creds: CredentialResolver,
    private readonly env: EnvService,
    private readonly activity: SandboxActivityRegistry,
    @Inject(DRIVER_REPO) private readonly repos: DriverRepoResolver,
    @Inject(SANDBOX_PROVIDER) private readonly sandboxProvider: SandboxProvider,
    private readonly provisioner: WorktreeProvisioner,
    private readonly jobDeps: JobDependencyService,
    private readonly turnRegistry: TurnRegistry,
    private readonly moduleRef: ModuleRef,
    private readonly brainGateway: BrainGateway,
    private readonly skillUpdater: SkillUpdaterService,
    @Optional()
    private readonly driverStore?: DriverStoreService,
    @Optional()
    private readonly jobBootstrap?: JobBootstrapService,
  ) {}

  private get archiveInactivityTtlMs(): number {
    const raw = Number(this.env.get('ARCHIVE_INACTIVITY_TTL_MS'));
    if (Number.isFinite(raw) && raw > 0) return raw;
    return DEFAULT_ARCHIVE_INACTIVITY_TTL_MS;
  }

  contextDirHost(jobId: string, orgId: string): string {
    return this.sandboxProvider.contextDirHost(orgId, jobId);
  }

  draftUploadsDirHost(jobId: string, orgId: string, userId: string): string {
    return this.sandboxProvider.draftUploadsDirHost(orgId, jobId, userId);
  }

  supervisorDirHost(jobId: string): string | null {
    return this.sandboxProvider.supervisorDirHost(jobId);
  }

  async probeLiveness(jobId: string, pgids: number[]): Promise<ServiceLivenessProbe> {
    try {
      return await this.sandboxProvider.probeLiveness(jobId, pgids);
    } catch (err) {
      this.logger.warn(
        `probeLiveness(${jobId.slice(0, 8)}) threw — reporting unknown: ${String(err)}`,
      );
      return { status: 'unknown' };
    }
  }

  async createJob(input: CreateThreadInput): Promise<CreatedThread> {
    const { orgId, repoId, displayName } = input;

    const project = await this.projects.findOne({
      where: { id: repoId, org_id: orgId },
    });
    if (!project) {
      throw new Error(`No connected repo id=${repoId} for org=${orgId} — connect it first`);
    }
    const baseBranch = input.baseBranch ?? project.default_branch ?? 'main';

    const thread = await this.jobs.save(
      this.jobs.create({
        org_id: orgId,
        repo_id: repoId,
        origin: 'control',
        surface_thread_ref: null,
        title: displayName ?? null,
        base_branch: baseBranch,
      }),
    );
    this.logger.log(`created thread ${thread.id} for ${orgId}/${project.slug} on ${baseBranch}`);

    await this.jobBootstrap?.ensurePlanningThreadGroup(thread.id, orgId);

    const sandboxRow = await this.provisionSandbox(thread, project, baseBranch);

    this.skillUpdater.reconcileOrgAsync(orgId);

    return {
      jobId: thread.id,
      threadSandboxId: sandboxRow.id,
      worktreePath: sandboxRow.worktree_path,
      baseBranch,
    };
  }

  async ensureProvisioned(
    jobId: string,
    orgId: string,
    onMilestone?: (stage: SandboxMilestoneStage) => void,
  ): Promise<JobSandboxEntity | null> {
    const key = `${orgId}:${jobId}`;
    const inflight = this.provisioning.get(key);
    if (inflight) return inflight;
    const p = this.doEnsureProvisioned(jobId, orgId, onMilestone).finally(() =>
      this.provisioning.delete(key),
    );
    this.provisioning.set(key, p);
    return p;
  }

  private async doEnsureProvisioned(
    jobId: string,
    orgId: string,
    onMilestone?: (stage: SandboxMilestoneStage) => void,
  ): Promise<JobSandboxEntity | null> {
    const thread = await this.jobs.findOne({
      where: { id: jobId, org_id: orgId },
    });
    if (!thread) return null;

    const existing = await this.sandboxes.findOne({
      where: { job_id: jobId, org_id: orgId },
    });
    if (existing) {
      if (existing.lifecycle === 'closed') return null;
      if (existing.worktree_path && thread.feature_branch) return existing;
      if (existing.container_id) {
        await this.sandboxProvider
          .teardown(await this.rowToSandbox(existing))
          .catch((err) =>
            this.logger.warn(
              `ensureProvisioned: teardown of stale sandbox failed for ${jobId}: ${err}`,
            ),
          );
      }
      await this.sandboxes.delete({ id: existing.id });
      this.logger.log(`ensureProvisioned: replaced incomplete sandbox row for thread ${jobId}`);
    }

    const project = await this.projects.findOne({
      where: { id: thread.repo_id, org_id: orgId },
    });
    if (!project) {
      throw new ProvisioningNotReadyError(
        'This thread’s repo could not be found — reconnect it in settings.',
      );
    }
    if (!project.access_ok) {
      const healed = await this.tryRevalidateAccess(orgId, project.id);
      if (!healed) {
        throw new ProvisioningNotReadyError(
          'This repo isn’t fully connected yet — finish connecting it (validate GitHub access) in settings before starting a thread.',
        );
      }
    }
    const baseBranch = thread.base_branch ?? project.default_branch ?? 'main';
    return this.provisionSandbox(thread, project, baseBranch, onMilestone);
  }

  private async tryRevalidateAccess(orgId: string, repoId: string): Promise<boolean> {
    try {
      const onboarding = this.moduleRef.get(OnboardingService, {
        strict: false,
      });
      const res = await onboarding.revalidateRepo(orgId, repoId);
      if (res.accessOk) this.logger.log(`auto-healed repo access for ${repoId} (org ${orgId})`);
      return res.accessOk;
    } catch (err) {
      this.logger.warn(`access revalidation failed for repo ${repoId}: ${err}`);
      return false;
    }
  }

  async deliverEphemeralSecret(input: {
    jobId: string;
    path: string;
    value: string;
    timeoutMs?: number;
  }): Promise<{ ok: boolean; reason?: string }> {
    const deliver = this.sandboxProvider.writeToJobContainerPath?.bind(this.sandboxProvider);
    if (!deliver) {
      return { ok: false, reason: 'ephemeral delivery is unavailable' };
    }
    return deliver(input);
  }

  async findSandbox(jobId: string, orgId: string): Promise<FeatureSandbox | null> {
    const row = await this.sandboxes.findOne({
      where: { job_id: jobId, org_id: orgId },
    });
    if (!row || row.lifecycle === 'closed') return null;
    return this.rowToSandbox(row);
  }

  async resolveBaseBranch(jobId: string, orgId: string): Promise<string> {
    const thread = await this.jobs.findOne({
      where: { id: jobId, org_id: orgId },
    });
    const project = thread ? await this.projects.findOne({ where: { id: thread.repo_id } }) : null;
    return thread?.base_branch ?? project?.default_branch ?? 'main';
  }

  async rehydrateThread(jobId: string, orgId: string): Promise<boolean> {
    const key = `${orgId}:${jobId}`;
    await this.provisioning.get(key)?.catch(() => undefined);

    const row = await this.sandboxes.findOne({
      where: { job_id: jobId, org_id: orgId },
    });
    if (!row || row.lifecycle === 'closed') return false;
    if (!row.worktree_path || !existsSync(row.worktree_path)) return false;

    const { sandbox: attached, hydrationSig } = await this.provisioner.provisionAndAttach({
      sandbox: await this.rowToSandbox(row),
      orgId,
      jobId,
      repoDbId: row.repo_id,
      forceHydrate: true,
    });
    row.worktree_path = attached.worktreePath;
    row.container_id = attached.containerId ?? null;
    row.hydration_sig = hydrationSig;
    row.last_active_at = new Date();
    row.setup_error = setupErrorFrom(attached);
    await this.sandboxes.save(row);
    return true;
  }

  async ensureContainer(
    jobId: string,
    orgId: string,
    onMilestone?: (stage: SandboxMilestoneStage) => void,
  ): Promise<{ sandbox: FeatureSandbox; wasReset: boolean } | null> {
    const row = await this.sandboxes.findOne({
      where: { job_id: jobId, org_id: orgId },
    });
    if (!row || row.lifecycle === 'closed') return null;

    let worktreeRestored = false;
    if (!row.worktree_path || !existsSync(row.worktree_path)) {
      await this.ensureWorktree(row, await this.repoForRow(row));
      worktreeRestored = true;
    }

    const { sandbox: attached, hydrationSig } = await this.provisioner.provisionAndAttach({
      sandbox: await this.rowToSandbox(row),
      orgId,
      jobId,
      repoDbId: row.repo_id,
      knownSig: row.hydration_sig ?? undefined,
      forceHydrate: worktreeRestored,
      onMilestone,
    });

    const wasReset = attached.warm === false;
    row.worktree_path = attached.worktreePath;
    row.container_id = attached.containerId ?? null;
    row.lifecycle = 'attached';
    row.last_active_at = new Date();
    row.hydration_sig = hydrationSig;
    row.setup_error = setupErrorFrom(attached);
    await this.sandboxes.save(row);

    if (wasReset)
      this.logger.log(
        `thread ${jobId} re-attached a COLD container — turn will be told the sandbox reset`,
      );
    return { sandbox: attached, wasReset };
  }

  async closeJob(jobId: string, orgId: string): Promise<void> {
    const row = await this.sandboxes.findOne({
      where: { job_id: jobId, org_id: orgId },
    });
    if (!row || row.lifecycle === 'closed') return;

    await this.sandboxProvider
      .teardownByIdentity({
        sandbox: await this.rowToSandbox(row),
        orgId,
        jobId,
      })
      .catch((err) => {
        this.logger.warn(`closeJob: teardown failed for thread ${jobId}: ${err}`);
      });
    if (row.worktree_path) {
      const projectRepo = await this.repoForRow(row).catch(() => null);
      if (projectRepo) {
        await this.git.removeSandbox(projectRepo, row.worktree_path).catch((err) => {
          this.logger.warn(`closeJob: worktree remove failed for thread ${jobId}: ${err}`);
        });
      }
    }

    await this.sandboxes.update({ id: row.id }, { container_id: null, lifecycle: 'closed' });
    this.logger.log(`closed thread ${jobId} (container + worktree torn down)`);
  }

  async detachJobContainer(jobId: string, orgId: string): Promise<void> {
    const row = await this.sandboxes.findOne({
      where: { job_id: jobId, org_id: orgId },
    });
    if (!row || row.lifecycle === 'closed') return; // already fully torn down — leave it.
    await this.sandboxProvider
      .teardownByIdentity({
        sandbox: await this.rowToSandbox(row),
        orgId,
        jobId,
      })
      .catch((err) => {
        this.logger.warn(`detachJobContainer: teardown failed for thread ${jobId}: ${err}`);
      });
    await this.sandboxes.update({ id: row.id }, { container_id: null, lifecycle: 'detached' });
    this.logger.log(
      `detached thread ${jobId} on PR-terminal (container freed, worktree + session kept)`,
    );
  }

  async claimDeleteJob(jobId: string, orgId: string): Promise<boolean> {
    const res = await this.jobs.update(
      { id: jobId, org_id: orgId, status: Not('deleting') },
      { status: 'deleting' },
    );
    return (res.affected ?? 0) > 0;
  }

  async closeJobPullRequest(job: JobEntity): Promise<void> {
    if (job.pr_state !== 'open') return; // nothing open to close — no-op
    if (job.pr_number == null) {
      throw new Error(`cannot close PR for job ${job.id}: missing PR number`);
    }
    const repo = await this.projects.findOne({
      where: { id: job.repo_id, org_id: job.org_id },
    });
    const parsed = repo ? parseGithubRepoUrl(repo.git_url) : null;
    const token = await this.creds.hostGithubToken(job.org_id);
    if (!parsed || !token) {
      throw new Error(`cannot resolve GitHub repo/token to close PR for job ${job.id}`);
    }
    await this.pr.closePullRequest(token, {
      owner: parsed.owner,
      repo: parsed.repo,
      number: job.pr_number,
    });
  }

  async deleteJobDeep(jobId: string, orgId: string): Promise<void> {
    await this.closeJob(jobId, orgId);

    this.removeJobPlaygroundDir(orgId, jobId);
    this.removeJobDraftUploadsDir(orgId, jobId);
    this.removeJobContextDir(orgId, jobId);
    this.removeOnDiskSessionJsonl(jobId);

    await this.projects
      .update({ org_id: orgId, onboarding_job_id: jobId }, { onboarding_job_id: null })
      .catch(() => undefined);

    await this.jobDeps
      .onBlockerResolved(jobId, 'deleted')
      .catch((err) =>
        this.logger.warn(`deleteJobDeep: wake funnel failed for blocker ${jobId}: ${err}`),
      );

    const res = await this.jobs.delete({ id: jobId, org_id: orgId });
    this.logger.log(
      `deleted thread ${jobId} (org ${orgId}); thread rows removed=${res.affected ?? 0}, children cascaded`,
    );
  }

  async claimArchiveJob(jobId: string, orgId: string): Promise<boolean> {
    const res = await this.jobs.update(
      { id: jobId, org_id: orgId, status: Not(In(['archived', 'deleting'])) },
      { status: 'archived', archived_at: new Date() },
    );
    return (res.affected ?? 0) > 0;
  }

  async reclaimJobArtifacts(jobId: string, orgId: string): Promise<boolean> {
    const row = await this.sandboxes.findOne({
      where: { job_id: jobId, org_id: orgId },
    });
    if (!row || row.lifecycle === 'closed') return true; // nothing owed
    let ok = true;
    try {
      await this.sandboxProvider.teardownByIdentity({
        sandbox: await this.rowToSandbox(row),
        orgId,
        jobId,
      });
    } catch (err) {
      ok = false;
      this.logger.warn(`archive: container teardown failed for ${jobId}: ${err}`);
    }
    if (row.worktree_path) {
      const repo = await this.repoForRow(row).catch(() => null);
      if (repo) {
        try {
          await this.git.removeSandbox(repo, row.worktree_path);
        } catch (err) {
          ok = false;
          this.logger.warn(`archive: worktree remove threw for ${jobId}: ${err}`);
        }
      }
      if (existsSync(row.worktree_path)) {
        ok = false;
        this.logger.warn(`archive: worktree still present after remove for ${jobId}`);
      }
    }
    if (ok) {
      await this.sandboxes.update({ id: row.id }, { container_id: null, lifecycle: 'closed' });
    }
    return ok; // false ⇒ lifecycle stays non-closed ⇒ reconciler retries
  }

  async archiveJobDeep(jobId: string, orgId: string): Promise<void> {
    await this.reclaimJobArtifacts(jobId, orgId); // container + worktree — gates the reconciler retry
    this.removeJobPlaygroundDir(orgId, jobId); // best-effort, small; NOT /context (kept — decision d2)
    this.removeJobDraftUploadsDir(orgId, jobId); // staged composer uploads — scratch like /playground
    this.removeOnDiskSessionJsonl(jobId); // best-effort; redundant with transcript_messages (decision d4)

    await this.projects
      .update({ org_id: orgId, onboarding_job_id: jobId }, { onboarding_job_id: null })
      .catch(() => undefined);

    await this.jobDeps
      .onBlockerResolved(jobId, 'archived')
      .catch((err) =>
        this.logger.warn(`archiveJobDeep: wake funnel failed for blocker ${jobId}: ${err}`),
      );
  }

  async archiveInactiveJobs(): Promise<number> {
    const cutoff = new Date(Date.now() - this.archiveInactivityTtlMs);
    const rows = await this.jobs
      .createQueryBuilder('j')
      .select(['j.id', 'j.org_id'])
      .where('j.status NOT IN (:...archiveExcluded)', {
        archiveExcluded: ['archived', 'deleting'],
      })
      .andWhere('j.pr_state IN (:...terminal)', {
        terminal: ['merged', 'closed'],
      })
      .andWhere(
        '(SELECT MAX(m.created_at) FROM transcript_messages m WHERE m.job_id = j.id) < :cutoff',
        { cutoff },
      )
      .getMany();
    let archived = 0;
    for (const j of rows) {
      try {
        if (await this.claimArchiveJob(j.id, j.org_id)) {
          await this.archiveJobDeep(j.id, j.org_id);
          archived++;
        }
      } catch (err) {
        this.logger.warn(`archiveInactiveJobs: archive of job ${j.id} failed: ${err}`);
      }
    }
    if (archived) this.logger.log(`archiveInactiveJobs: archived ${archived} idle job(s)`);
    return archived;
  }

  async reconcileArchivedSandboxes(): Promise<number> {
    const rows = await this.jobs
      .createQueryBuilder('j')
      .innerJoin('job_sandboxes', 's', 's.job_id = j.id')
      .where('j.status = :arch', { arch: 'archived' })
      .andWhere("s.lifecycle <> 'closed'")
      .select(['j.id', 'j.org_id'])
      .getMany();
    let retried = 0;
    for (const j of rows) {
      try {
        await this.archiveJobDeep(j.id, j.org_id);
        retried++;
      } catch (err) {
        this.logger.warn(
          `reconcileArchivedSandboxes: reclaim retry for job ${j.id} failed: ${err}`,
        );
      }
    }
    if (retried)
      this.logger.log(
        `reconcileArchivedSandboxes: re-attempted reclaim for ${retried} archived job(s)`,
      );
    return retried;
  }

  async reconcileDeletingJobs(): Promise<number> {
    const stuck = await this.jobs.find({
      where: { status: 'deleting' },
      select: { id: true, org_id: true },
    });
    let swept = 0;
    for (const job of stuck) {
      try {
        await this.deleteJobDeep(job.id, job.org_id);
        swept++;
      } catch (err) {
        this.logger.warn(`reconcileDeletingJobs: finishing delete of job ${job.id} failed: ${err}`);
      }
    }
    if (swept) this.logger.log(`reconcileDeletingJobs: finished ${swept} stranded delete(s)`);
    return swept;
  }

  async applyGithubPrState(
    job: JobEntity,
    state: 'open' | 'merged' | 'closed' | 'gone',
  ): Promise<'noop'> {
    if (state === 'open') return 'noop';
    const prState = state === 'gone' ? 'closed' : state; // 'merged' | 'closed'
    await this.jobs.update({ id: job.id }, { pr_state: prState });
    if (this.driverStore) {
      await this.driverStore
        .neutralizeMergeCard(job.id, prState === 'merged' ? 'merged' : 'not-ready')
        .catch(() => undefined);
    }
    await this.jobDeps
      .onBlockerResolved(job.id, prState === 'merged' ? 'merged' : 'closed_unmerged')
      .catch((err) =>
        this.logger.warn(`applyGithubPrState: wake funnel failed for blocker ${job.id}: ${err}`),
      );
    return 'noop';
  }

  async pollPrClosures(): Promise<number> {
    const threads = await this.jobs.find({
      where: {
        pr_number: Not(IsNull()),
        status: Not(In(['archived', 'deleting'])),
      },
    });
    let applied = 0;
    for (const thread of threads) {
      try {
        const sandbox = await this.sandboxes.findOne({
          where: { job_id: thread.id },
        });
        if (
          !sandbox ||
          sandbox.lifecycle === 'closed' ||
          thread.pr_state === 'merged' ||
          thread.pr_state === 'closed'
        )
          continue;
        const project = await this.projects.findOne({
          where: { id: thread.repo_id },
        });
        const parsed = project ? parseGithubRepoUrl(project.git_url) : null;
        const token = await this.creds.hostGithubToken(thread.org_id);
        if (!parsed || !token || thread.pr_number == null) continue;
        const state = await this.pr.getPullState(token, {
          owner: parsed.owner,
          repo: parsed.repo,
          number: thread.pr_number,
        });
        await this.applyGithubPrState(thread, state);
        if (state !== 'open') {
          this.logger.log(
            `thread ${thread.id} PR #${thread.pr_number} is ${state} — pr_state recorded (sandbox kept until archive)`,
          );
          applied++;
        }
      } catch (err) {
        this.logger.debug(`pollPrClosures: thread ${thread.id} check failed: ${err}`);
      }
    }
    if (applied) this.logger.log(`pollPrClosures: recorded ${applied} terminal PR state(s)`);
    return applied;
  }

  private removeJobPlaygroundDir(orgId: string, jobId: string): void {
    const dir = this.sandboxProvider.playgroundDirHost(orgId, jobId);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      this.logger.warn(`removeJobPlaygroundDir: remove failed for ${dir}: ${err}`);
    }
  }

  private removeJobDraftUploadsDir(orgId: string, jobId: string): void {
    const dir = this.draftUploadsJobDirHost(orgId, jobId);
    if (!dir) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      this.logger.warn(`removeJobDraftUploadsDir: remove failed for ${dir}: ${err}`);
    }
  }

  private draftUploadsJobDirHost(orgId: string, jobId: string): string | null {
    const marker = '__job_root__';
    const probe = this.sandboxProvider.draftUploadsDirHost(orgId, jobId, marker);
    if (basename(probe) !== marker) return null;
    const dir = dirname(probe);
    return dir === dirname(dir) ? null : dir;
  }

  private removeJobContextDir(orgId: string, jobId: string): void {
    const dir = this.sandboxProvider.contextDirHost(orgId, jobId);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      this.logger.warn(`removeJobContextDir: remove failed for ${dir}: ${err}`);
    }
  }

  private removeOnDiskSessionJsonl(jobId: string): void {
    const dir = this.sandboxProvider.brainTranscriptProjectsDir(jobId);
    if (!dir) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      this.logger.warn(`removeOnDiskSessionJsonl: remove failed for ${dir}: ${err}`);
    }
  }

  async reapIdle(): Promise<number> {
    const ttlMs = DEFAULT_IDLE_TTL_MS;
    const cutoff = Date.now() - ttlMs;
    const rows = await this.sandboxes.find({
      where: { lifecycle: 'attached' },
    });
    let reaped = 0;
    for (const row of rows) {
      if (!row.container_id) continue;
      if (this.activity.isBusy(row.container_id)) continue; // never mid-turn (this process)
      const active = await this.jobs.findOne({
        where: { id: row.job_id },
        select: { id: true, activity: true },
      });
      if (active && active.activity !== 'idle') continue;
      if (row.last_active_at && row.last_active_at.getTime() > cutoff) continue; // recently active
      await this.detachContainer(row, 'idle');
      reaped++;
    }
    if (reaped) this.logger.log(`reapIdle: detached ${reaped} idle sandbox container(s)`);
    return reaped;
  }

  async reapOrphanedSandboxArtifacts(): Promise<void> {
    await this.sandboxProvider.reapOrphanedArtifacts?.();
  }

  async reconcileOnBoot(): Promise<void> {
    const res = await this.sandboxes.update(
      { lifecycle: Not('closed') },
      { lifecycle: 'detached', container_id: null },
    );
    if (res.affected)
      this.logger.log(`boot reconcile: marked ${res.affected} thread sandbox(es) detached`);
  }

  async resetContainer(
    jobId: string,
    orgId: string,
  ): Promise<{ reset: true } | { reset: false; reason: 'no-container' | 'busy' }> {
    const row = await this.sandboxes.findOne({
      where: { job_id: jobId, org_id: orgId },
    });
    if (!row || row.lifecycle === 'closed' || !row.container_id) {
      return { reset: false, reason: 'no-container' };
    }
    if (this.activity.isBusy(row.container_id)) return { reset: false, reason: 'busy' };
    await this.detachContainer(row, 'reset');
    return { reset: true };
  }

  private async detachContainer(row: JobSandboxEntity, reason: 'idle' | 'reset'): Promise<void> {
    await this.turnRegistry
      .failRunningForJob(row.job_id)
      .then(
        (n) =>
          n &&
          this.logger.log(
            `detachContainer(${reason}): dropped ${n} running turn row(s) for ${row.job_id}`,
          ),
      )
      .catch((err) =>
        this.logger.debug(`detachContainer(${reason}): failRunningForJob failed (ignored): ${err}`),
      );
    await this.sandboxProvider.teardown(await this.rowToSandbox(row)).catch((err) => {
      this.logger.warn(
        `detachContainer(${reason}): teardown failed for thread ${row.job_id}: ${err}`,
      );
    });
    row.container_id = null;
    row.lifecycle = 'detached';
    await this.sandboxes.save(row);
    this.logger.log(`detached thread ${row.job_id} container (${reason})`);
  }

  private async provisionSandbox(
    thread: JobEntity,
    project: RepoEntity,
    baseBranch: string,
    onMilestone?: (stage: SandboxMilestoneStage) => void,
  ): Promise<JobSandboxEntity> {
    const row = await this.sandboxes.save(
      this.sandboxes.create({
        org_id: thread.org_id,
        job_id: thread.id,
        repo_id: project.id,
        worktree_path: '', // filled in below
        container_id: null,
        lifecycle: 'provisioning',
      }),
    );

    try {
      const token = await this.creds.hostGithubToken(thread.org_id);
      const projectRepo = await this.git.ensureRepo({
        repoId: project.slug,
        gitUrl: project.git_url,
        defaultBranch: baseBranch,
        ...(token ? { token } : {}),
      });

      const featureBranch = computeFeatureBranchName(project, thread.id);
      const baseSandboxInput = (await this.git.hasSubmodules(projectRepo))
        ? await this.git.createBaseClone(projectRepo, thread.id)
        : await this.git.createBaseWorktree(projectRepo, thread.id);
      const branched = await this.git.switchBranch(baseSandboxInput, projectRepo, featureBranch);

      await this.git.ensureSubmodules(branched.worktreePath, projectRepo);

      const { sandbox: attached, hydrationSig } = await this.provisioner.provisionAndAttach({
        sandbox: branched,
        orgId: thread.org_id,
        jobId: thread.id,
        repoDbId: project.id,
        forceHydrate: true,
        onMilestone,
      });

      row.worktree_path = attached.worktreePath;
      row.container_id = attached.containerId ?? null;
      row.lifecycle = 'attached';
      row.last_active_at = new Date();
      row.hydration_sig = hydrationSig;
      row.setup_error = setupErrorFrom(attached);
      await this.sandboxes.save(row);

      await this.jobs.update({ id: thread.id }, { feature_branch: featureBranch });

      this.logger.log(
        `provisioned sandbox for thread ${thread.id} on ${featureBranch}: worktree=${attached.worktreePath}` +
          (attached.containerId ? ` container=${attached.containerId.slice(0, 12)}` : ' (local)'),
      );

      if (row.setup_error) {
        this.logger.warn(
          `setup script failed on cold bring-up for thread ${thread.id} — recorded (setup_error); awaiting operator`,
        );
      }
    } catch (err) {
      row.lifecycle = 'detached';
      await this.sandboxes.save(row).catch(() => undefined);
      throw err;
    }

    return row;
  }

  async markRepoOnboarded(orgId: string, repoId: string): Promise<void> {
    await this.projects.update(
      { id: repoId, org_id: orgId, onboarded_at: IsNull() },
      { onboarded_at: new Date() },
    );
    this.logger.log(`repo ${repoId} (org ${orgId}) marked onboarded`);
  }

  private async repoForRow(row: JobSandboxEntity): Promise<ProjectRepo> {
    const project = await this.projects.findOne({ where: { id: row.repo_id } });
    if (!project) throw new Error(`No repos row for id=${row.repo_id} (org=${row.org_id})`);
    const token = await this.creds.hostGithubToken(row.org_id);
    return this.git.ensureRepo({
      repoId: project.slug,
      gitUrl: project.git_url,
      defaultBranch: project.default_branch,
      ...(token ? { token } : {}),
    });
  }

  private async ensureWorktree(row: JobSandboxEntity, projectRepo: ProjectRepo): Promise<void> {
    if (row.worktree_path && existsSync(row.worktree_path)) return;
    const sb = await this.recutWorktree(row, projectRepo);
    this.logger.log(`restored missing worktree for thread ${row.job_id} at ${sb.worktreePath}`);
  }

  private async recutWorktree(
    row: JobSandboxEntity,
    projectRepo: ProjectRepo,
  ): Promise<FeatureSandbox> {
    const thread = await this.jobs.findOne({ where: { id: row.job_id } });
    const base = (await this.git.hasSubmodules(projectRepo))
      ? await this.git.createBaseClone(projectRepo, row.job_id)
      : await this.git.createBaseWorktree(projectRepo, row.job_id);
    const desired = thread?.current_branch ?? thread?.feature_branch ?? null;
    const target =
      desired && (await this.git.refExists(base.worktreePath, `refs/heads/${desired}`))
        ? desired
        : (thread?.feature_branch ?? null);
    const sb = target ? await this.git.switchBranch(base, projectRepo, target) : base;
    await this.git.ensureSubmodules(sb.worktreePath, projectRepo);
    row.worktree_path = sb.worktreePath;
    return sb;
  }

  async hardResetSandbox(
    jobId: string,
    orgId: string,
  ): Promise<{ reset: true } | { reset: false; reason: 'no-container' | 'busy' }> {
    const row = await this.sandboxes.findOne({
      where: { job_id: jobId, org_id: orgId },
    });
    if (!row || row.lifecycle === 'closed') return { reset: false, reason: 'no-container' };
    if (row.container_id && this.activity.isBusy(row.container_id)) {
      return { reset: false, reason: 'busy' };
    }
    const projectRepo = await this.repoForRow(row);

    await this.detachContainer(row, 'reset');
    await this.git.removeSandbox(projectRepo, row.worktree_path);
    this.logger.log(
      `hard-reset sandbox for thread ${jobId} — worktree removed; next attach re-cuts from scratch`,
    );
    return { reset: true };
  }

  private async rowToSandbox(row: JobSandboxEntity): Promise<FeatureSandbox> {
    const thread = await this.jobs.findOne({ where: { id: row.job_id } });
    const project = await this.projects.findOne({ where: { id: row.repo_id } });
    const branch =
      thread?.feature_branch ?? thread?.base_branch ?? project?.default_branch ?? 'main';
    const execUser = row.container_id ? hostExecUser() : undefined;
    return {
      repoId: project?.slug ?? row.repo_id,
      branch,
      worktreePath: row.worktree_path,
      gitUrl: '', // Not stored on the row — resolved lazily when needed (push/PR is repo-level)
      ...(row.container_id ? { containerId: row.container_id } : {}),
      ...(execUser ? { execUser } : {}),
    };
  }
}
