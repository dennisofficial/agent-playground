import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { existsSync, rmSync } from 'node:fs';
import { In, IsNull, Not, Repository } from 'typeorm';
import type { FeatureSandbox, ProjectRepo } from '../git';
import { GithubPrService, LocalGitService, parseGithubRepoUrl } from '../git';
import { CredentialResolver, OnboardingService } from '../onboarding';
import { BrainGateway } from '../brain-gateway';
import { JobBootstrapService } from '../job-bootstrap';
import { JobDependencyService } from '../job-deps';
import { DB_CONNECTION } from '../persistence/database.module';
import { RepoEntity, JobEntity, JobSandboxEntity } from '../persistence/entities';
import { SkillUpdaterService } from '../skills/skill-updater.service';
import {
  hostExecUser,
  SANDBOX_PROVIDER,
  SandboxActivityRegistry,
  type SandboxMilestoneStage,
  type SandboxProvider,
  type ServiceLivenessProbe,
} from '../sandbox';
import { TurnRegistry } from '../sandbox/turn-registry.service';
import { computeFeatureBranchName } from './branch-naming';
import { DriverStoreService } from './driver-store.service';
import { DRIVER_REPO, type DriverRepoResolver } from './repo-resolver';
import { WorktreeProvisioner } from './worktree-provisioner.service';

/**
 * Idle window before an attached-but-quiet container is reaped to `detached` (30 min). Reaping
 * removes the container, which frees the RAM of any dev servers the job left running under `atlas-svc`;
 * the durable worktree/branch/session survive and the next turn cold-re-attaches (with the reset
 * notice). Jobs run in peaks — hard work, then a long idle waiting for PR review — so a short window
 * reclaims a shared host (RAM is the bottleneck) without meaningfully hurting anyone; the idle-reap
 * sweep runs every minute (see `DriverModule`), so a quiet container is reclaimed ~30 min after its
 * last turn.
 */
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;

/**
 * Sandbox lifecycle status strings (mirrors the entity comment).
 */
export type ThreadSandboxLifecycle = 'provisioning' | 'attached' | 'detached' | 'closed';

/** Input to `createJob` — everything needed to open a new workspace thread. */
export interface CreateThreadInput {
  orgId: string;
  /** The repo's uuid id (FK → repos.id). */
  repoId: string;
  /** HTTPS GitHub URL for the project (required on first use; omit if the project is already registered). */
  repoUrl?: string;
  /** The base branch the operator picked (default = repo's default branch). */
  baseBranch?: string;
  /** Short display title for the thread. */
  displayName?: string;
}

/** The key output of a `createJob` call. */
export interface CreatedThread {
  jobId: string;
  threadSandboxId: string;
  worktreePath: string;
  baseBranch: string;
}

/**
 * Thrown by `ensureProvisioned` when a thread's repo isn't connected/validated yet (no repo row, or
 * `access_ok` is false) — so provisioning can't proceed. The brain surfaces the message to the operator
 * (finish onboarding) instead of attempting a doomed clone.
 */
export class ProvisioningNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisioningNotReadyError';
  }
}

/**
 * R2 — the EXPLICIT CREATE-THREAD control path + per-thread sandbox lifecycle. A thread owns a DURABLE
 * worktree + feature branch + engine session; its container is a DISPOSABLE cache attached on demand.
 * The THREAD row owns the branch (`base_branch`/`feature_branch`) and PR (`pr_url`/`pr_number`); the
 * `thread_sandboxes` row is pure INFRA (worktree path + container + chat session + lifecycle).
 *
 *   1. `createJob` — persist the `threads` row, then provision the sandbox: cut the worktree AND the
 *      thread's feature branch (`feature/<id>`) at create, attach a thread-keyed container.
 *   2. `ensureContainer` — every turn calls this first: reuse the warm container, or re-attach a cold
 *      one against the durable worktree, returning `wasReset` so a resumed turn knows its runtime is fresh.
 *   3. `reapIdle` — detach idle containers past the TTL (worktree survives).
 *   4. `closeJob` / `pollPrClosures` — terminal cleanup (PR merged or operator close).
 */

/**
 * Format a cold-boot setup-script outcome for `job_sandboxes.setup_error` — the failure as `exit <N>: <tail>`,
 * or null when the run succeeded / there was no script (which clears any stale error). Pure.
 */
function setupErrorFrom(sandbox: FeatureSandbox): string | null {
  const r = sandbox.setupScriptResult;
  return r && !r.ok ? `exit ${r.exitCode}: ${r.tail}` : null;
}

/** How long a merged/closed job's sandbox may sit `detached` (RAM already freed, worktree kept so the
 *  conversation stays resumable) before the disk GC reclaims its worktree + scratch dirs. A week of
 *  post-merge resume-ability, then reclaim; the job row + transcript always survive. */
const MERGED_SANDBOX_GC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class JobLifecycleService {
  private readonly logger = new Logger(JobLifecycleService.name);

  /** In-flight lazy provisions, keyed `orgId:jobId` — serializes concurrent first turns (single-process). */
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
    // Kept for the lazy `OnboardingService` lookup (revalidateRepo) that would otherwise close a load
    // cycle with the @Global onboarding module. The brain wake now comes through the neutral gateway.
    private readonly moduleRef: ModuleRef,
    // The cold-boot provisioning-failure wake seam — the neutral driver→brain gateway (the brain binds
    // itself into it on bootstrap). Injecting it forms no construction cycle, unlike a
    // `useExisting: AgentSessionManager` port (the brain constructs this service → DI deadlock).
    private readonly brainGateway: BrainGateway,
    private readonly skillUpdater: SkillUpdaterService,
    // Neutralize any live "Merge PR" card on a terminal PR state — this is the single shared entry point
    // for every terminal path (webhook fast path + poll backstop), so it also catches a PR merged/closed
    // outside `AutoMergeService.mergeNow`. No DI cycle: DriverStoreService doesn't depend on this service.
    @Optional()
    private readonly driverStore?: DriverStoreService,
    // Bootstraps the job's ONE planning stage + thread right after the bare `JobEntity` row is inserted
    // (d7: `stage_id` is never null, even for a job that never gets a plan). @Optional (trailing), same
    // reason as `driverStore` above.
    @Optional()
    private readonly jobBootstrap?: JobBootstrapService,
  ) {}

  /**
   * The HOST path of the thread's durable `/context` shared folder (mounted into the sandbox at
   * `/context`). The brain reads spec files it authored in-sandbox via this path. Pure path derivation —
   * no I/O, safe to call before the sandbox exists (the dir is created when the container is attached).
   */
  contextDirHost(jobId: string, orgId: string): string {
    return this.sandboxProvider.contextDirHost(orgId, jobId);
  }

  /**
   * The HOST path of the thread's `atlas-svc` supervisor dir (markers + logs for processes the agent
   * started via `atlas-svc run`). Null when the thread has no sandbox home on disk yet (never
   * provisioned, or a fresh worktree with no supervised process started).
   */
  supervisorDirHost(jobId: string): string | null {
    return this.sandboxProvider.supervisorDirHost(jobId);
  }

  /**
   * Probe the job's container for which supervised process-groups are alive (see
   * {@link SandboxProvider.probeLiveness}). Catches here too so a provider that throws despite its own
   * guard still degrades to `unknown` rather than failing the status endpoint.
   */
  async probeLiveness(jobId: string, pgids: number[]): Promise<ServiceLivenessProbe> {
    try {
      return await this.sandboxProvider.probeLiveness(jobId, pgids);
    } catch (err) {
      this.logger.warn(`probeLiveness(${jobId.slice(0, 8)}) threw — reporting unknown: ${String(err)}`);
      return { status: 'unknown' };
    }
  }

  /**
   * Create a new thread: persist the thread + provision the sandbox (worktree + feature branch cut at
   * create, container attached). Returns immediately after the sandbox is marked `attached`.
   */
  async createJob(input: CreateThreadInput): Promise<CreatedThread> {
    const { orgId, repoId, displayName } = input;

    // The repo must already be connected (onboarding's connectRepo). Resolve it (scoped to the org) for
    // its base branch.
    const project = await this.projects.findOne({ where: { id: repoId, org_id: orgId } });
    if (!project) {
      throw new Error(`No connected repo id=${repoId} for org=${orgId} — connect it first`);
    }
    const baseBranch = input.baseBranch ?? project.default_branch ?? 'main';

    // Persist the threads row (origin='control', base_branch set on the THREAD).
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

    // Bootstrap the job's ONE planning stage + thread — d7: `stage_id` is never null, even for a job
    // that never gets a plan proposed.
    await this.jobBootstrap?.ensurePlanningStage(thread.id, orgId);

    // Provision the sandbox on the base branch.
    const sandboxRow = await this.provisionSandbox(thread, project, baseBranch);

    // Fire-and-forget "on job start" skill-update check (the plan's second update trigger, alongside the
    // updater's own cadence) — never awaited, so a slow/unreachable skill source can't delay job creation.
    this.skillUpdater.reconcileOrgAsync(orgId);

    return {
      jobId: thread.id,
      threadSandboxId: sandboxRow.id,
      worktreePath: sandboxRow.worktree_path,
      baseBranch,
    };
  }

  /**
   * Idempotently ensure a thread has a COMPLETE sandbox (durable worktree + feature branch + the
   * `thread_sandboxes` row). The live create/seed paths insert BARE thread rows (no sandbox), so the
   * brain's first chat turn calls this to provision lazily. Uniform recovery semantics:
   *
   *   - no row                      → provision.
   *   - row `closed`                → return null (a closed thread isn't revived by a stray message).
   *   - row complete (worktree_path set AND the thread has a feature_branch) → return it (no-op). A
   *     healthy post-restart row (`reconcileOnBoot` → `detached`, container null, worktree+branch kept)
   *     IS complete; `ensureContainer` re-attaches it on the turn.
   *   - row INCOMPLETE (a failed provision: `detached`, empty worktree_path / no feature_branch) →
   *     reclaim any container, drop the stale row, provision fresh.
   *
   * Throws `ProvisioningNotReadyError` if the repo isn't connected/validated (`access_ok`) — fail fast,
   * no clone. Concurrent first turns for the same thread share ONE provision (no double row).
   */
  async ensureProvisioned(
    jobId: string,
    orgId: string,
    onMilestone?: (stage: SandboxMilestoneStage) => void,
  ): Promise<JobSandboxEntity | null> {
    const key = `${orgId}:${jobId}`;
    const inflight = this.provisioning.get(key);
    if (inflight) return inflight;
    // Set the promise SYNCHRONOUSLY (before any await) so racing callers share it.
    const p = this.doEnsureProvisioned(jobId, orgId, onMilestone).finally(() => this.provisioning.delete(key));
    this.provisioning.set(key, p);
    return p;
  }

  private async doEnsureProvisioned(
    jobId: string,
    orgId: string,
    onMilestone?: (stage: SandboxMilestoneStage) => void,
  ): Promise<JobSandboxEntity | null> {
    const thread = await this.jobs.findOne({ where: { id: jobId, org_id: orgId } });
    if (!thread) return null;

    const existing = await this.sandboxes.findOne({ where: { job_id: jobId, org_id: orgId } });
    if (existing) {
      if (existing.lifecycle === 'closed') return null;
      // Complete iff BOTH the worktree path and the thread's feature branch are set. A failed
      // provisionSandbox leaves a `detached` row with neither (and rowToSandbox would otherwise fall
      // back to the base/default branch) — treat that as incomplete and re-provision.
      if (existing.worktree_path && thread.feature_branch) return existing;
      if (existing.container_id) {
        await this.sandboxProvider
          .teardown(await this.rowToSandbox(existing))
          .catch((err) =>
            this.logger.warn(`ensureProvisioned: teardown of stale sandbox failed for ${jobId}: ${err}`),
          );
      }
      await this.sandboxes.delete({ id: existing.id });
      this.logger.log(`ensureProvisioned: replaced incomplete sandbox row for thread ${jobId}`);
    }

    const project = await this.projects.findOne({ where: { id: thread.repo_id, org_id: orgId } });
    if (!project) {
      throw new ProvisioningNotReadyError(
        'This thread’s repo could not be found — reconnect it in settings.',
      );
    }
    if (!project.access_ok) {
      // Auto-heal: `access_ok` is often just stale — a repo connected but never (re)validated. Re-probe
      // GitHub once with the org token before bouncing the operator to settings; if access is actually
      // fine this proceeds transparently. Only a genuinely broken/expired PAT still throws.
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

  /**
   * Re-probe a repo's GitHub access with the org token and persist the fresh `access_ok` (via
   * OnboardingService.revalidateRepo). Returns whether access is now good. Resolved lazily through
   * ModuleRef to avoid a constructor cycle with the @Global onboarding module. Best-effort — any
   * failure (network, resolution) returns false so the caller falls back to the not-ready message.
   */
  private async tryRevalidateAccess(orgId: string, repoId: string): Promise<boolean> {
    try {
      const onboarding = this.moduleRef.get(OnboardingService, { strict: false });
      const res = await onboarding.revalidateRepo(orgId, repoId);
      if (res.accessOk) this.logger.log(`auto-healed repo access for ${repoId} (org ${orgId})`);
      return res.accessOk;
    } catch (err) {
      this.logger.warn(`access revalidation failed for repo ${repoId}: ${err}`);
      return false;
    }
  }

  /**
   * Deliver an EPHEMERAL secret value straight into a path in the thread's LIVE container (a FIFO the brain
   * wired a waiting process to read) over exec stdin — never persisted, never granted, never on the card.
   * Thin pass-through to the sandbox provider's optional {@link SandboxProvider.writeToJobContainerPath};
   * returns `{ ok:false }` (rather than throwing) when the provider can't deliver, so the `provide-secret`
   * endpoint can tell the operator to retry instead of wedging.
   */
  async deliverEphemeralSecret(input: {
    jobId: string;
    path: string;
    value: string;
    timeoutMs?: number;
  }): Promise<{ ok: boolean; reason?: string }> {
    const deliver = this.sandboxProvider.writeToJobContainerPath?.bind(
      this.sandboxProvider,
    );
    if (!deliver) {
      return { ok: false, reason: 'ephemeral delivery is unavailable' };
    }
    return deliver(input);
  }

  /**
   * Look up the sandbox row for a thread, returning its current `FeatureSandbox` (or null if none
   * exists). Read-only (no attach) — used where a live container isn't required (e.g. plan-review).
   */
  async findSandbox(jobId: string, orgId: string): Promise<FeatureSandbox | null> {
    const row = await this.sandboxes.findOne({ where: { job_id: jobId, org_id: orgId } });
    if (!row) return null;
    return this.rowToSandbox(row);
  }

  /** Resolve the job's base branch (base_branch ?? repo default_branch ?? 'main') — for diffing vs base. */
  async resolveBaseBranch(jobId: string, orgId: string): Promise<string> {
    const thread = await this.jobs.findOne({ where: { id: jobId, org_id: orgId } });
    const project = thread ? await this.projects.findOne({ where: { id: thread.repo_id } }) : null;
    return thread?.base_branch ?? project?.default_branch ?? 'main';
  }

  /**
   * Force an immediate re-hydration of a thread's RUNNING sandbox — called right after the operator
   * provides a secret/file, so the newly-granted value is on disk BEFORE the masked-confirmation turn
   * runs (otherwise the value wouldn't render until the next lazy provision). Serializes with any
   * in-flight lazy provision via the same `orgId:jobId` key, then `forceHydrate`s the existing worktree
   * and persists the new hydration signature. Returns false (no-op) when the thread has no attachable
   * worktree yet — the next real turn's `ensureContainer` will hydrate it anyway.
   */
  async rehydrateThread(jobId: string, orgId: string): Promise<boolean> {
    const key = `${orgId}:${jobId}`;
    // Chain onto any in-flight lazy provision so we never hydrate the same worktree concurrently with it.
    await this.provisioning.get(key)?.catch(() => undefined);

    const row = await this.sandboxes.findOne({ where: { job_id: jobId, org_id: orgId } });
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

  // ── private helpers ───────────────────────────────────────────────────────────────────────────

  /**
   * (Re-)attach a live container for a thread, on demand. The worktree + branch + session are durable;
   * the container is a disposable cache. Returns the live `FeatureSandbox` and `wasReset` — true when a
   * COLD container was attached. Returns null if the thread has no sandbox row or it is already `closed`.
   * Self-heals a missing worktree (crash / host-down) by recreating it on the feature branch first.
   */
  async ensureContainer(
    jobId: string,
    orgId: string,
    onMilestone?: (stage: SandboxMilestoneStage) => void,
  ): Promise<{ sandbox: FeatureSandbox; wasReset: boolean } | null> {
    const row = await this.sandboxes.findOne({ where: { job_id: jobId, org_id: orgId } });
    if (!row || row.lifecycle === 'closed') return null;

    // Common path: the durable worktree is present → skip the repo resolve (a git fetch) entirely. Only
    // resolve + restore when it's actually gone (crash / host-down / pruned). A restored worktree has no
    // hydrated files, so force a re-hydration in that case.
    let worktreeRestored = false;
    if (!row.worktree_path || !existsSync(row.worktree_path)) {
      await this.ensureWorktree(row, await this.repoForRow(row));
      worktreeRestored = true;
    }

    // Hydrate (granted secrets/seed) only when stale or the worktree was just restored, then attach.
    // EVERY thread (incl. onboarding) now renders real secrets — see WorktreeHydrator for the rationale.
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
    // Stamp the cold-boot setup outcome (cleared on a clean/warm run); the brain's imminent turn drains it.
    row.setup_error = setupErrorFrom(attached);
    await this.sandboxes.save(row);

    if (wasReset) this.logger.log(`thread ${jobId} re-attached a COLD container — turn will be told the sandbox reset`);
    return { sandbox: attached, wasReset };
  }

  /**
   * Terminal cleanup — tear down the container AND remove the worktree, flip the row to `closed`. Called
   * on PR merge / explicit thread close / abandon. Idempotent: a `closed` row is a no-op. Leaves the
   * branch ref (the PR/merge owns it). Best-effort on each side so a half-gone sandbox still closes.
   */
  async closeJob(jobId: string, orgId: string): Promise<void> {
    const row = await this.sandboxes.findOne({ where: { job_id: jobId, org_id: orgId } });
    if (!row || row.lifecycle === 'closed') return;

    // Tear down the container by its DETERMINISTIC identity, NOT by `row.container_id`. `reconcileOnBoot`
    // nulls `container_id` on every restart while the real container keeps running, so a close/delete of a
    // thread that hasn't had a turn since the last restart would otherwise skip teardown and orphan the
    // container (+ its network/volume) forever. Resolving by name reclaims it either way.
    await this.sandboxProvider
      .teardownByIdentity({ sandbox: await this.rowToSandbox(row), orgId, jobId })
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

    // Scoped UPDATE, NOT `save(row)`: a concurrent delete can cascade this sandbox row away between the
    // `findOne` above and here (the `job_sandboxes.job_id` FK is ON DELETE CASCADE). `save` on a
    // now-missing row would INSERT it back — resurrecting a row whose parent job is gone → the
    // `fk_job_sandboxes_job_id_jobs` violation. An UPDATE affects 0 rows in that race and is a safe no-op.
    await this.sandboxes.update({ id: row.id }, { container_id: null, lifecycle: 'closed' });
    this.logger.log(`closed thread ${jobId} (container + worktree torn down)`);
  }

  /**
   * The RAM-free TWIN of {@link closeJob}, used on a terminal PR state (merge/close): reclaim the CONTAINER
   * but PRESERVE the worktree + `session_id`, so the operator's next message re-attaches a fresh container to
   * the existing worktree and RESUMES the same brain session with full context (vs `closeJob`, which removes
   * the worktree + flips to `closed` → `doEnsureProvisioned` returns null → a fresh session = amnesia). A
   * stale detached worktree is later reclaimed for disk by {@link reapMergedSandboxes}.
   *
   * Modeled on `closeJob` EXACTLY for the two things that matter: `teardownByIdentity` (not `teardown`) so a
   * boot-reconciled row — `container_id` nulled on restart while the real container still runs — is still
   * reclaimed by deterministic name (+ its net/volume artifacts); and a scoped `update` (not `save`) so a
   * concurrent cascade delete can't resurrect the row. Differs only in: no worktree removal, lifecycle
   * `detached` (not `closed`). Guards ONLY on `closed` (a detached-but-still-running container must still be
   * reclaimed, so it does not short-circuit on `detached`).
   */
  async detachJobContainer(jobId: string, orgId: string): Promise<void> {
    const row = await this.sandboxes.findOne({ where: { job_id: jobId, org_id: orgId } });
    if (!row || row.lifecycle === 'closed') return; // already fully torn down — leave it.
    await this.sandboxProvider
      .teardownByIdentity({ sandbox: await this.rowToSandbox(row), orgId, jobId })
      .catch((err) => {
        this.logger.warn(`detachJobContainer: teardown failed for thread ${jobId}: ${err}`);
      });
    await this.sandboxes.update({ id: row.id }, { container_id: null, lifecycle: 'detached' });
    this.logger.log(`detached thread ${jobId} on PR-terminal (container freed, worktree + session kept)`);
  }

  /**
   * Terminal DELETE of a thread and EVERYTHING it owns — two layers, in order:
   *   1. `closeJob` — the PHYSICAL teardown a database can't do: reclaim the Docker container and the
   *      git worktree (flips the sandbox row to `closed`; no-op if already closed).
   *   2. delete the org-scoped `threads` row — the database then CASCADES every child row (messages,
   *      threads, steps, decision_records, stimuli, thread_sandboxes) through the `ON DELETE CASCADE`
   *      FKs added in the `RestoreReferentialIntegrity` migration. No app-side child sweep is needed.
   *
   * The delete is org-scoped (defense-in-depth beyond the caller's membership check). Idempotent and safe
   * to call on a partially-gone thread.
   */
  /**
   * Atomically claim a job for web deletion — flip `status` → `'deleting'` in a single conditional UPDATE,
   * returning whether THIS caller won the claim. SEPARATE from {@link deleteJobDeep} (the physical teardown)
   * so the durable `deleting` marker can be committed + rendered by the UI (it rides the thread list + WAL
   * realtime) BEFORE the slow container/worktree teardown runs in the background.
   *
   * Single-flight: the `status <> 'deleting'` guard makes a second concurrent DELETE match 0 rows and
   * return false — so the two requests can't interleave into the cascade-then-resurrect race that caused
   * the `fk_job_sandboxes_job_id_jobs` crash. Returns false too if the job is already gone. Org-scoped.
   *
   * NOTE: this is layered ONLY on the web DELETE endpoint. The parent-delete paths (org delete, repo
   * disconnect) and the reconciler call {@link deleteJobDeep} directly — it keeps its synchronous,
   * always-tears-down-and-deletes-the-row contract, which those drain loops depend on.
   */
  async claimDeleteJob(jobId: string, orgId: string): Promise<boolean> {
    const res = await this.jobs.update(
      { id: jobId, org_id: orgId, status: Not('deleting') },
      { status: 'deleting' },
    );
    return (res.affected ?? 0) > 0;
  }

  /** Close the job's OPEN PR on GitHub (no merge). Throws if it can't — the caller aborts the delete. */
  async closeJobPullRequest(job: JobEntity): Promise<void> {
    if (job.pr_state !== 'open') return; // nothing open to close — no-op
    if (job.pr_number == null) {
      throw new Error(`cannot close PR for job ${job.id}: missing PR number`);
    }
    const repo = await this.projects.findOne({ where: { id: job.repo_id, org_id: job.org_id } });
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
    // 1. Reclaim the container + worktree (physical side effects — no DB cascade can do this).
    await this.closeJob(jobId, orgId);

    // 1b. Remove the job's durable host-side scratch dirs — `closeJob` reclaims the container + worktree but
    //     these live OUTSIDE the worktree (keyed by jobId), so nothing else deletes them.
    this.removeJobScratchDirs(orgId, jobId);

    // 2. If this was a repo's onboarding thread, release the spawn marker so a re-connect can re-onboard
    //    (the marker is a pointer, not an FK — it would otherwise dangle and block re-spawn forever).
    await this.projects
      .update({ org_id: orgId, onboarding_job_id: jobId }, { onboarding_job_id: null })
      .catch(() => undefined);

    // 2b. Wake any job blocked on this one BEFORE the delete cascades its dependency edges away.
    await this.jobDeps
      .onBlockerResolved(jobId, 'deleted')
      .catch((err) => this.logger.warn(`deleteJobDeep: wake funnel failed for blocker ${jobId}: ${err}`));

    // 3. Delete the thread row; the FK ON DELETE CASCADE removes every child row with it.
    const res = await this.jobs.delete({ id: jobId, org_id: orgId });
    this.logger.log(`deleted thread ${jobId} (org ${orgId}); thread rows removed=${res.affected ?? 0}, children cascaded`);
  }

  // ── reaping / reconciliation (driven by DriverModule's boot hook + interval) ────────────────────

  /**
   * Finish any job stranded mid-delete — a job left in `status='deleting'` because the process crashed
   * between {@link claimDeleteJob} and the background {@link deleteJobDeep} completing. Re-runs the full
   * teardown (idempotent: `closeJob` no-ops a closed sandbox, `jobs.delete` no-ops a gone row). Best-effort
   * per job. Run leader-only on boot + from the reap interval so a stuck delete self-heals without a
   * restart. Returns how many jobs it swept.
   */
  async reconcileDeletingJobs(): Promise<number> {
    const stuck = await this.jobs.find({ where: { status: 'deleting' }, select: { id: true, org_id: true } });
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

  /**
   * Apply an authoritative GitHub PR state to a job: terminal `pr_state` write (authoritative sidebar
   * glyph) FIRST, then sandbox teardown. Ordering is load-bearing — the write is the authoritative
   * observer so purple/red are immediate; `closeJob` is last. Idempotent — an `open` state is a no-op;
   * `gone` (PR/repo deleted) folds to `closed`. Shared by the `pull_request` webhook (fast path) and
   * `pollPrClosures` (30-min backstop) so they can't drift.
   */
  async applyGithubPrState(
    job: JobEntity,
    state: 'open' | 'merged' | 'closed' | 'gone',
  ): Promise<'closed' | 'noop'> {
    if (state === 'open') return 'noop';
    const prState = state === 'gone' ? 'closed' : state; // 'merged' | 'closed'
    await this.jobs.update({ id: job.id }, { pr_state: prState });
    // Retire any live "Merge PR" card now the PR is terminal — the shared point every terminal path funnels
    // through, so a PR merged/closed by any means (github.com, a click, a poll) can't leave a stale button.
    if (this.driverStore) {
      await this.driverStore
        .neutralizeMergeCard(job.id, prState === 'merged' ? 'merged' : 'not-ready')
        .catch(() => undefined);
    }
    await this.jobDeps
      .onBlockerResolved(job.id, prState === 'merged' ? 'merged' : 'closed_unmerged')
      .catch((err) => this.logger.warn(`applyGithubPrState: wake funnel failed for blocker ${job.id}: ${err}`));
    // DETACH, not close: free the container's RAM but KEEP the worktree + session so a post-merge follow-up
    // resumes the brain with full context (a merged PR should "just free RAM, never delete data"). The
    // worktree is reclaimed for disk later by `reapMergedSandboxes` once it's sat detached past the TTL.
    await this.detachJobContainer(job.id, job.org_id);
    return 'closed';
  }

  /**
   * Poll the PR of every thread that has one (the PR lives on the THREAD now) whose sandbox isn't
   * `closed`; when it has merged or closed (or was deleted), `closeJob` to reclaim the container +
   * worktree. Best-effort per thread. Returns how many threads were closed.
   */
  async pollPrClosures(): Promise<number> {
    const threads = await this.jobs.find({ where: { pr_number: Not(IsNull()) } });
    let closed = 0;
    for (const thread of threads) {
      try {
        const sandbox = await this.sandboxes.findOne({ where: { job_id: thread.id } });
        // Skip already-terminal jobs: a closed sandbox, OR a job whose `pr_state` is already merged/closed
        // (its teardown ran — since merge now DETACHES rather than closing, the lifecycle-only guard would
        // otherwise re-poll + re-apply + re-count a detached merged job every 30 min forever).
        if (
          !sandbox ||
          sandbox.lifecycle === 'closed' ||
          thread.pr_state === 'merged' ||
          thread.pr_state === 'closed'
        )
          continue;
        const project = await this.projects.findOne({ where: { id: thread.repo_id } });
        const parsed = project ? parseGithubRepoUrl(project.git_url) : null;
        const token = await this.creds.hostGithubToken(thread.org_id);
        if (!parsed || !token || thread.pr_number == null) continue;
        const state = await this.pr.getPullState(token, {
          owner: parsed.owner,
          repo: parsed.repo,
          number: thread.pr_number,
        });
        const outcome = await this.applyGithubPrState(thread, state);
        if (outcome === 'closed') {
          this.logger.log(`thread ${thread.id} PR #${thread.pr_number} is ${state} — closing thread`);
          closed++;
        }
      } catch (err) {
        this.logger.debug(`pollPrClosures: thread ${thread.id} check failed: ${err}`);
      }
    }
    if (closed) this.logger.log(`pollPrClosures: closed ${closed} merged/closed thread(s)`);
    return closed;
  }

  /** Remove a job's durable host-side scratch dirs (`/playground` + `/context`) — they live OUTSIDE the
   *  worktree (keyed by jobId), so neither `closeJob` nor a worktree removal touches them. Best-effort;
   *  never throws. Used by `deleteJobDeep` (hard delete) and `reapMergedSandboxes` (disk GC). */
  private removeJobScratchDirs(orgId: string, jobId: string): void {
    for (const dir of [
      this.sandboxProvider.playgroundDirHost(orgId, jobId),
      this.sandboxProvider.contextDirHost(orgId, jobId),
    ]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        this.logger.warn(`removeJobScratchDirs: remove failed for ${dir}: ${err}`);
      }
    }
  }

  /**
   * Disk GC for merged/closed jobs whose sandbox has sat `detached` past {@link MERGED_SANDBOX_GC_TTL_MS}.
   * Merge now DETACHES (frees the container RAM immediately, keeps the worktree so the conversation stays
   * resumable) — but nothing reclaims that worktree, so without this it grows unbounded. Runs the full
   * `closeJob` (worktree + container-by-identity + `closed`) AND `removeJobScratchDirs` (`/context`,
   * `/playground` — which `closeJob` does NOT touch). The job row + transcript SURVIVE (never a data delete);
   * the conversation just becomes non-resumable past the TTL (start a new job). Leader-only, best-effort;
   * returns how many were reclaimed.
   */
  async reapMergedSandboxes(): Promise<number> {
    const cutoff = Date.now() - MERGED_SANDBOX_GC_TTL_MS;
    const jobs = await this.jobs.find({
      where: { pr_state: In(['merged', 'closed']) },
      select: { id: true, org_id: true },
    });
    let reclaimed = 0;
    for (const job of jobs) {
      try {
        const sandbox = await this.sandboxes.findOne({
          where: { job_id: job.id, org_id: job.org_id },
        });
        // Only a still-detached row past the cutoff: an `attached` (re-engaged) or already-`closed` row is
        // left alone, and a recently-detached one stays resumable until it ages out.
        if (!sandbox || sandbox.lifecycle !== 'detached') continue;
        if (!sandbox.updated_at || sandbox.updated_at.getTime() >= cutoff) continue;
        await this.closeJob(job.id, job.org_id);
        this.removeJobScratchDirs(job.org_id, job.id);
        reclaimed++;
      } catch (err) {
        this.logger.warn(`reapMergedSandboxes: reclaim of job ${job.id} failed: ${err}`);
      }
    }
    if (reclaimed)
      this.logger.log(`reapMergedSandboxes: reclaimed disk for ${reclaimed} stale merged sandbox(es)`);
    return reclaimed;
  }

  /**
   * Reap the CONTAINER (not the worktree) of every `attached` thread that has been idle past the TTL and
   * is not mid-turn → flip it to `detached`. The durable worktree + branch + session stay; the next turn
   * re-attaches (cold) with the reset notice. Returns how many were reaped.
   */
  async reapIdle(): Promise<number> {
    const ttlMs = DEFAULT_IDLE_TTL_MS;
    const cutoff = Date.now() - ttlMs;
    const rows = await this.sandboxes.find({ where: { lifecycle: 'attached' } });
    let reaped = 0;
    for (const row of rows) {
      if (!row.container_id) continue;
      if (this.activity.isBusy(row.container_id)) continue; // never mid-turn (this process)
      // Durable cross-process guard: never reap a container whose job has any non-idle system activity on
      // ANY instance. Plan review also uses the job container and can outlive its enclosing brain turn.
      // `this.activity` is in-memory/per-process; the DB `activity` column survives the brief leader overlap
      // of a rolling deploy (defense-in-depth — the single-leader invariant already means no other process
      // is reaping, but this is cheap insurance).
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

  /**
   * Reclaim leaked per-sandbox Docker artifacts (`-net` networks + `-dind` volumes) whose owning container is
   * gone — the catch-all that keeps Docker's address pool from being exhausted by networks orphaned across
   * crashes / restarts / swallowed `removeNetwork` races. Thin pass-through to the provider's optional
   * {@link SandboxProvider.reapOrphanedArtifacts} (no-op for a provider that doesn't implement it, e.g. a test
   * fake). Scheduled by the driver's leader-gated reap timer + once on leadership acquisition (see DriverModule).
   */
  async reapOrphanedSandboxArtifacts(): Promise<void> {
    await this.sandboxProvider.reapOrphanedArtifacts?.();
  }

  /**
   * On boot, mark every non-`closed` row `detached` + null its `container_id`: after a restart no
   * container is confirmed live, so the next turn's `ensureContainer` re-resolves it. The worktree is
   * restored lazily on that next turn (on the FEATURE branch, via `ensureWorktree`). Also rescues
   * half-finished `provisioning` rows.
   */
  async reconcileOnBoot(): Promise<void> {
    const res = await this.sandboxes.update(
      { lifecycle: Not('closed') },
      { lifecycle: 'detached', container_id: null },
    );
    if (res.affected) this.logger.log(`boot reconcile: marked ${res.affected} thread sandbox(es) detached`);
  }


  /**
   * On-demand RESET of a thread's container: tear it down + flip to `detached`, keeping the durable
   * worktree AND `session_id` — so the next `ensureContainer` re-attaches a COLD container (`wasReset`) and
   * resumes the same session. This is the primitive behind the brain's `reset_sandbox` tool (Atlas proves
   * its environment cold-boots on a fresh box). Refuses to touch a container that a turn is actively running
   * in (`busy`) — a concurrent driver build would otherwise be killed mid-flight.
   */
  async resetContainer(
    jobId: string,
    orgId: string,
  ): Promise<{ reset: true } | { reset: false; reason: 'no-container' | 'busy' }> {
    const row = await this.sandboxes.findOne({ where: { job_id: jobId, org_id: orgId } });
    if (!row || row.lifecycle === 'closed' || !row.container_id) {
      return { reset: false, reason: 'no-container' };
    }
    if (this.activity.isBusy(row.container_id)) return { reset: false, reason: 'busy' };
    await this.detachContainer(row, 'reset');
    return { reset: true };
  }

  /** Tear down a row's container (best-effort) and flip it to `detached`. Worktree untouched. */
  private async detachContainer(row: JobSandboxEntity, reason: 'idle' | 'reset'): Promise<void> {
    // Drop any `running` turn row bound to this container BEFORE tearing it down: the engine is about to
    // die, so a lingering `running` row would make the steer path treat it as a live turn and XADD the
    // operator's next message into an unread input stream (silently lost) until the watchdog's stale
    // window cleans it. Best-effort — the durable delivery pump's liveness probe is the primary guard.
    await this.turnRegistry
      .failRunningForJob(row.job_id)
      .then((n) => n && this.logger.log(`detachContainer(${reason}): dropped ${n} running turn row(s) for ${row.job_id}`))
      .catch((err) => this.logger.debug(`detachContainer(${reason}): failRunningForJob failed (ignored): ${err}`));
    await this.sandboxProvider.teardown(await this.rowToSandbox(row)).catch((err) => {
      this.logger.warn(`detachContainer(${reason}): teardown failed for thread ${row.job_id}: ${err}`);
    });
    row.container_id = null;
    row.lifecycle = 'detached';
    await this.sandboxes.save(row);
    this.logger.log(`detached thread ${row.job_id} container (${reason})`);
  }

  // ── private helpers ───────────────────────────────────────────────────────────────────────────

  private async provisionSandbox(
    thread: JobEntity,
    project: RepoEntity,
    baseBranch: string,
    onMilestone?: (stage: SandboxMilestoneStage) => void,
  ): Promise<JobSandboxEntity> {
    // Persist the row in `provisioning` state first (crash-safe: if we fail after this we can detect
    // the orphaned row on recovery).
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
      // The repo's SLUG is the on-disk clone/worktree identity (human-readable), NOT the uuid id.
      const projectRepo = await this.git.ensureRepo({
        repoId: project.slug,
        gitUrl: project.git_url,
        defaultBranch: baseBranch,
        ...(token ? { token } : {}),
      });

      // Cut the base-branch worktree, then cut the thread's feature branch IN-PLACE at create — a thread
      // IS a branch from the start (one branch / one PR per thread). The THREAD owns the feature branch
      // (single source of truth the driver builds on).
      // Host-named canonical branch: honors the repo's optional `branch_prefix` (falling back to the
      // neutral `feature/` default) so a repo can enforce its own convention (e.g. `feat/`).
      const featureBranch = computeFeatureBranchName(project, thread.id);
      const baseSandboxInput = (await this.git.hasSubmodules(projectRepo))
        ? await this.git.createBaseClone(projectRepo, thread.id)
        : await this.git.createBaseWorktree(projectRepo, thread.id);
      const branched = await this.git.switchBranch(baseSandboxInput, projectRepo, featureBranch);

      // Populate git submodules into the freshly cut worktree (no-op without a `.gitmodules`) so the
      // in-sandbox build can resolve submodule-provided packages (e.g. `@workspace/*`). `git worktree add`
      // does NOT do this; auth rides the org PAT just like the clone. Fail-soft.
      await this.git.ensureSubmodules(branched.worktreePath, projectRepo);

      // Hydrate the freshly-cut worktree (granted secrets + cache mounts) and attach the
      // execution environment (thread-keyed container). forceHydrate: the worktree is brand new.
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

      // Record the feature branch on the THREAD (single owner).
      await this.jobs.update({ id: thread.id }, { feature_branch: featureBranch });

      this.logger.log(
        `provisioned sandbox for thread ${thread.id} on ${featureBranch}: worktree=${attached.worktreePath}` +
          (attached.containerId ? ` container=${attached.containerId.slice(0, 12)}` : ' (local)'),
      );

      // A brand-new job whose setup script failed on this cold create has NO brain turn yet — proactively
      // WAKE the brain to fix it (the specific error rides into that turn via the `setup_error` drain). Never
      // let a wake hiccup break job creation. Not done on the re-attach paths (`ensureContainer`/
      // `rehydrateThread`) — those run around a brain turn that drains the notice on its own.
      if (row.setup_error) {
        await this.wakeBrainForSetupFailure(thread.id, thread.org_id, project.id).catch((err) =>
          this.logger.warn(`setup-failure wake skipped for thread ${thread.id}: ${err}`),
        );
      }
    } catch (err) {
      // Mark detached so a recovery pass / next ensureContainer can re-attach (or closeJob reclaims).
      row.lifecycle = 'detached';
      await this.sandboxes.save(row).catch(() => undefined);
      throw err;
    }

    return row;
  }

  /**
   * Stamp a repo's `onboarded_at` — proof its worktree provisioning config is live. Called from exactly
   * one place: the brain's `finish_onboarding`, synchronously — secrets and workspace config (mounts/seed)
   * are DB-backed now (see docs/adr/0003), so there is no PR-merge event to wait on. Idempotent (only
   * stamps when currently null).
   */
  async markRepoOnboarded(orgId: string, repoId: string): Promise<void> {
    await this.projects.update(
      { id: repoId, org_id: orgId, onboarded_at: IsNull() },
      { onboarded_at: new Date() },
    );
    this.logger.log(`repo ${repoId} (org ${orgId}) marked onboarded`);
  }

  /**
   * WAKE the job brain to deal with a cold-boot setup-script failure — reached through the neutral
   * `BrainGateway` (the brain binds itself into it on bootstrap), which avoids the DI construction cycle a
   * direct brain dependency would form. The concrete error is delivered into the woken turn from the
   * sandbox row's `setup_error`.
   */
  private async wakeBrainForSetupFailure(jobId: string, orgId: string, repoId: string): Promise<void> {
    await this.brainGateway.wakeForProvisioningFailure(jobId, orgId, repoId);
  }

  /** Resolve the `ProjectRepo` (clone path + token) for a sandbox row — keyed by the repo's SLUG. */
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

  /**
   * Ensure the row's durable worktree exists on disk, recreating it on the OBSERVED branch (or the host-named
   * feature branch) if it has gone (crash / host down / pruned). `createBaseWorktree` lands at the same
   * per-thread path and is idempotent; the branch refs live in the durable shared `.git`.
   *
   * Prefer `current_branch` (what the agent's HEAD was actually on — it may have `git checkout -b …`) when its
   * ref still exists, else fall back to `feature_branch`. Restoring blindly to the stale `feature_branch` would
   * resume the job on a branch MISSING the agent's post-rename commits (those survive in the shared `.git`
   * under the observed ref, so the recovery must re-checkout that ref, not the canonical name).
   */
  private async ensureWorktree(row: JobSandboxEntity, projectRepo: ProjectRepo): Promise<void> {
    if (row.worktree_path && existsSync(row.worktree_path)) return;
    const sb = await this.recutWorktree(row, projectRepo);
    this.logger.log(`restored missing worktree for thread ${row.job_id} at ${sb.worktreePath}`);
  }

  /**
   * Cut the job's durable worktree from scratch on its OWN branch (`current_branch` → `feature_branch`),
   * restoring the branch from origin for a full clone ({@link LocalGitService.switchBranch}), and re-populate
   * submodules. Sets `row.worktree_path` and returns the resulting sandbox. Shared by {@link ensureWorktree}
   * (crash recovery) and {@link hardResetSandbox} (operator/onboarding from-scratch reset). A submodule repo
   * is cut as a full clone here (`hasSubmodules ? createBaseClone : createBaseWorktree`), so a hard reset also
   * heals a checkout that was previously mis-cut as a linked worktree.
   */
  private async recutWorktree(row: JobSandboxEntity, projectRepo: ProjectRepo): Promise<FeatureSandbox> {
    const thread = await this.jobs.findOne({ where: { id: row.job_id } });
    const base = (await this.git.hasSubmodules(projectRepo))
      ? await this.git.createBaseClone(projectRepo, row.job_id)
      : await this.git.createBaseWorktree(projectRepo, row.job_id);
    const desired = thread?.current_branch ?? thread?.feature_branch ?? null;
    const target =
      desired && (await this.git.refExists(base.worktreePath, `refs/heads/${desired}`))
        ? desired
        : (thread?.feature_branch ?? null);
    const sb = target
      ? await this.git.switchBranch(base, projectRepo, target)
      : base;
    // A freshly cut worktree needs its submodules re-populated (no-op without a `.gitmodules`).
    await this.git.ensureSubmodules(sb.worktreePath, projectRepo);
    row.worktree_path = sb.worktreePath;
    return sb;
  }

  /**
   * HARD RESET of a job's sandbox: re-provision the whole thing FROM SCRATCH — a fresh worktree (deleted +
   * re-cut) AND a fresh container — exactly as if the job were just created, while KEEPING the coding session
   * (the `session_id` is untouched, so the next attach resumes the same brain history) and the durable
   * per-job `/context` + `/playground` mounts (separate host mounts re-bound by `provisionAndAttach`, never
   * touched here). This is the primitive behind the brain's `reset_sandbox({ hard:true })` — for onboarding
   * ("prove the WHOLE stack, incl. worktree hydration, cold-boots") and operator recovery ("do a hard reset"
   * to unstick a job, e.g. one whose worktree was mis-cut as a linked worktree).
   *
   * Mechanically this is {@link resetContainer} PLUS deleting the worktree: it tears the container down
   * (flip to `detached`) and `removeSandbox`-es the worktree directory, then STOPS. The heavy lifting — re-cut
   * the worktree ({@link ensureContainer} → {@link ensureWorktree} → {@link recutWorktree}, which cuts a
   * submodule repo as a full clone, healing a mis-cut linked worktree), force-hydrate it, and cold-attach a
   * fresh container with `wasReset` (so the brain is told to re-verify) — all happens on the NEXT
   * `ensureContainer`, exactly the crash-recovery path. `session_id` is left untouched (session resumes); the
   * `/context` + `/playground` mounts are separate and survive.
   *
   * The HOST NEVER COMMITS, so it cannot rescue uncommitted work: the caller (`reset_sandbox`) refuses on a
   * dirty tree / unpushed full-clone commits BEFORE arming this. Refuses a `busy` container (a live turn would
   * be killed mid-flight). `removeSandbox` is mode-aware (`rm -rf` a full clone / `git worktree remove` a
   * linked worktree); the branch ref survives (restored from origin for a clone on the re-cut).
   */
  async hardResetSandbox(
    jobId: string,
    orgId: string,
  ): Promise<{ reset: true } | { reset: false; reason: 'no-container' | 'busy' }> {
    const row = await this.sandboxes.findOne({ where: { job_id: jobId, org_id: orgId } });
    if (!row || row.lifecycle === 'closed') return { reset: false, reason: 'no-container' };
    if (row.container_id && this.activity.isBusy(row.container_id)) {
      return { reset: false, reason: 'busy' };
    }
    const projectRepo = await this.repoForRow(row);

    // Tear the container down (best-effort → `detached`), then blow the worktree away. The next
    // `ensureContainer` sees the missing worktree, re-cuts + force-hydrates it, and cold-attaches (`wasReset`).
    await this.detachContainer(row, 'reset');
    await this.git.removeSandbox(projectRepo, row.worktree_path);
    this.logger.log(`hard-reset sandbox for thread ${jobId} — worktree removed; next attach re-cuts from scratch`);
    return { reset: true };
  }

  /**
   * Convert a persisted `JobSandboxEntity` row to an in-memory `FeatureSandbox`. The branch comes from
   * the THREAD (single owner of feature/base branch); the on-disk repo identity is the repo's SLUG.
   */
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
