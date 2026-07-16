import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { existsSync, rmSync } from 'node:fs';
import { IsNull, Not, Repository } from 'typeorm';
import type { FeatureSandbox, ProjectRepo } from '../git';
import { GithubPrService, LocalGitService, parseGithubRepoUrl } from '../git';
import { CredentialResolver, OnboardingService } from '../onboarding';
import { BrainGateway } from '../brain-gateway';
import { JobBootstrapService } from '../job-bootstrap';
import { JobDependencyService } from '../job-deps';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  RepoEntity,
  JobEntity,
  JobSandboxEntity,
} from '../persistence/entities';
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
export type ThreadSandboxLifecycle =
  | 'provisioning'
  | 'attached'
  | 'detached'
  | 'closed';

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

/** Default idle window (since a job's LAST transcript activity) after which a merged/closed job
 *  auto-archives — env-overridable via `ARCHIVE_INACTIVITY_TTL_MS`. Aggressive by design (decision d3):
 *  a merged PR stays interactive for follow-ups, then archives 3 quiet days later, reclaiming its
 *  worktree/container while the row + transcript + /context survive. */
const DEFAULT_ARCHIVE_INACTIVITY_TTL_MS = 3 * 24 * 60 * 60 * 1000;

@Injectable()
export class JobLifecycleService {
  private readonly logger = new Logger(JobLifecycleService.name);

  /** In-flight lazy provisions, keyed `orgId:jobId` — serializes concurrent first turns (single-process). */
  private readonly provisioning = new Map<
    string,
    Promise<JobSandboxEntity | null>
  >();

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
    // Bootstraps the job's ONE planning thread group + thread right after the bare `JobEntity` row is inserted
    // (d7: `thread_group_id` is never null, even for a job that never gets a plan). @Optional (trailing), same
    // reason as `driverStore` above.
    @Optional()
    private readonly jobBootstrap?: JobBootstrapService,
  ) {}

  /** Idle window (since a job's last transcript activity) before a merged/closed job auto-archives —
   *  `ARCHIVE_INACTIVITY_TTL_MS` when set + valid, else the 3-day default. Read via the env service (same
   *  numeric-env pattern as `ThreadDriver.phaseTimeoutMs`); never a bare module constant. */
  private get archiveInactivityTtlMs(): number {
    const raw = Number(this.env.get('ARCHIVE_INACTIVITY_TTL_MS'));
    if (Number.isFinite(raw) && raw > 0) return raw;
    return DEFAULT_ARCHIVE_INACTIVITY_TTL_MS;
  }

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
  async probeLiveness(
    jobId: string,
    pgids: number[],
  ): Promise<ServiceLivenessProbe> {
    try {
      return await this.sandboxProvider.probeLiveness(jobId, pgids);
    } catch (err) {
      this.logger.warn(
        `probeLiveness(${jobId.slice(0, 8)}) threw — reporting unknown: ${String(err)}`,
      );
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
    const project = await this.projects.findOne({
      where: { id: repoId, org_id: orgId },
    });
    if (!project) {
      throw new Error(
        `No connected repo id=${repoId} for org=${orgId} — connect it first`,
      );
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
    this.logger.log(
      `created thread ${thread.id} for ${orgId}/${project.slug} on ${baseBranch}`,
    );

    // Bootstrap the job's ONE planning thread group + thread — d7: `thread_group_id` is never null, even for a job
    // that never gets a plan proposed.
    await this.jobBootstrap?.ensurePlanningThreadGroup(thread.id, orgId);

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
      // Complete iff BOTH the worktree path and the thread's feature branch are set. A failed
      // provisionSandbox leaves a `detached` row with neither (and rowToSandbox would otherwise fall
      // back to the base/default branch) — treat that as incomplete and re-provision.
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
      this.logger.log(
        `ensureProvisioned: replaced incomplete sandbox row for thread ${jobId}`,
      );
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
  private async tryRevalidateAccess(
    orgId: string,
    repoId: string,
  ): Promise<boolean> {
    try {
      const onboarding = this.moduleRef.get(OnboardingService, {
        strict: false,
      });
      const res = await onboarding.revalidateRepo(orgId, repoId);
      if (res.accessOk)
        this.logger.log(`auto-healed repo access for ${repoId} (org ${orgId})`);
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
  async findSandbox(
    jobId: string,
    orgId: string,
  ): Promise<FeatureSandbox | null> {
    const row = await this.sandboxes.findOne({
      where: { job_id: jobId, org_id: orgId },
    });
    if (!row) return null;
    return this.rowToSandbox(row);
  }

  /** Resolve the job's base branch (base_branch ?? repo default_branch ?? 'main') — for diffing vs base. */
  async resolveBaseBranch(jobId: string, orgId: string): Promise<string> {
    const thread = await this.jobs.findOne({
      where: { id: jobId, org_id: orgId },
    });
    const project = thread
      ? await this.projects.findOne({ where: { id: thread.repo_id } })
      : null;
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

    const row = await this.sandboxes.findOne({
      where: { job_id: jobId, org_id: orgId },
    });
    if (!row || row.lifecycle === 'closed') return false;
    if (!row.worktree_path || !existsSync(row.worktree_path)) return false;

    const { sandbox: attached, hydrationSig } =
      await this.provisioner.provisionAndAttach({
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
    const row = await this.sandboxes.findOne({
      where: { job_id: jobId, org_id: orgId },
    });
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
    const { sandbox: attached, hydrationSig } =
      await this.provisioner.provisionAndAttach({
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

    if (wasReset)
      this.logger.log(
        `thread ${jobId} re-attached a COLD container — turn will be told the sandbox reset`,
      );
    return { sandbox: attached, wasReset };
  }

  /**
   * Terminal cleanup — tear down the container AND remove the worktree, flip the row to `closed`. Called
   * on PR merge / explicit thread close / abandon. Idempotent: a `closed` row is a no-op. Leaves the
   * branch ref (the PR/merge owns it). Best-effort on each side so a half-gone sandbox still closes.
   */
  async closeJob(jobId: string, orgId: string): Promise<void> {
    const row = await this.sandboxes.findOne({
      where: { job_id: jobId, org_id: orgId },
    });
    if (!row || row.lifecycle === 'closed') return;

    // Tear down the container by its DETERMINISTIC identity, NOT by `row.container_id`. `reconcileOnBoot`
    // nulls `container_id` on every restart while the real container keeps running, so a close/delete of a
    // thread that hasn't had a turn since the last restart would otherwise skip teardown and orphan the
    // container (+ its network/volume) forever. Resolving by name reclaims it either way.
    await this.sandboxProvider
      .teardownByIdentity({
        sandbox: await this.rowToSandbox(row),
        orgId,
        jobId,
      })
      .catch((err) => {
        this.logger.warn(
          `closeJob: teardown failed for thread ${jobId}: ${err}`,
        );
      });
    if (row.worktree_path) {
      const projectRepo = await this.repoForRow(row).catch(() => null);
      if (projectRepo) {
        await this.git
          .removeSandbox(projectRepo, row.worktree_path)
          .catch((err) => {
            this.logger.warn(
              `closeJob: worktree remove failed for thread ${jobId}: ${err}`,
            );
          });
      }
    }

    // Scoped UPDATE, NOT `save(row)`: a concurrent delete can cascade this sandbox row away between the
    // `findOne` above and here (the `job_sandboxes.job_id` FK is ON DELETE CASCADE). `save` on a
    // now-missing row would INSERT it back — resurrecting a row whose parent job is gone → the
    // `fk_job_sandboxes_job_id_jobs` violation. An UPDATE affects 0 rows in that race and is a safe no-op.
    await this.sandboxes.update(
      { id: row.id },
      { container_id: null, lifecycle: 'closed' },
    );
    this.logger.log(`closed thread ${jobId} (container + worktree torn down)`);
  }

  /**
   * The RAM-free TWIN of {@link closeJob}: reclaim the CONTAINER but PRESERVE the worktree + `session_id`, so
   * the operator's next message re-attaches a fresh container to the existing worktree and RESUMES the same
   * brain session with full context (vs `closeJob`, which removes the worktree + flips to `closed` →
   * `doEnsureProvisioned` returns null → a fresh session = amnesia). NO LONGER called on merge (decision d5 —
   * a merged job stays interactive; its RAM is freed by the idle {@link reapIdle} sweep instead, and its
   * worktree is reclaimed only at archive by {@link archiveInactiveJobs}). Retained as the shared detach
   * primitive; a stale detached worktree is later reclaimed for disk when the job is archived.
   *
   * Modeled on `closeJob` EXACTLY for the two things that matter: `teardownByIdentity` (not `teardown`) so a
   * boot-reconciled row — `container_id` nulled on restart while the real container still runs — is still
   * reclaimed by deterministic name (+ its net/volume artifacts); and a scoped `update` (not `save`) so a
   * concurrent cascade delete can't resurrect the row. Differs only in: no worktree removal, lifecycle
   * `detached` (not `closed`). Guards ONLY on `closed` (a detached-but-still-running container must still be
   * reclaimed, so it does not short-circuit on `detached`).
   */
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
        this.logger.warn(
          `detachJobContainer: teardown failed for thread ${jobId}: ${err}`,
        );
      });
    await this.sandboxes.update(
      { id: row.id },
      { container_id: null, lifecycle: 'detached' },
    );
    this.logger.log(
      `detached thread ${jobId} on PR-terminal (container freed, worktree + session kept)`,
    );
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
    const repo = await this.projects.findOne({
      where: { id: job.repo_id, org_id: job.org_id },
    });
    const parsed = repo ? parseGithubRepoUrl(repo.git_url) : null;
    const token = await this.creds.hostGithubToken(job.org_id);
    if (!parsed || !token) {
      throw new Error(
        `cannot resolve GitHub repo/token to close PR for job ${job.id}`,
      );
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
    //     these live OUTSIDE the worktree (keyed by jobId), so nothing else deletes them. A hard delete drops
    //     BOTH /playground and /context (unlike archive, which keeps /context — decision d2).
    this.removeJobPlaygroundDir(orgId, jobId);
    this.removeJobContextDir(orgId, jobId);

    // 2. If this was a repo's onboarding thread, release the spawn marker so a re-connect can re-onboard
    //    (the marker is a pointer, not an FK — it would otherwise dangle and block re-spawn forever).
    await this.projects
      .update(
        { org_id: orgId, onboarding_job_id: jobId },
        { onboarding_job_id: null },
      )
      .catch(() => undefined);

    // 2b. Wake any job blocked on this one BEFORE the delete cascades its dependency edges away.
    await this.jobDeps
      .onBlockerResolved(jobId, 'deleted')
      .catch((err) =>
        this.logger.warn(
          `deleteJobDeep: wake funnel failed for blocker ${jobId}: ${err}`,
        ),
      );

    // 3. Delete the thread row; the FK ON DELETE CASCADE removes every child row with it.
    const res = await this.jobs.delete({ id: jobId, org_id: orgId });
    this.logger.log(
      `deleted thread ${jobId} (org ${orgId}); thread rows removed=${res.affected ?? 0}, children cascaded`,
    );
  }

  // ── archive (in-place TERMINAL lifecycle: reclaim filesystem, KEEP row + transcript + analytics + /context) ──

  /**
   * Atomically CLAIM a job for archiving — flip `status` → `'archived'` + stamp `archived_at` in a single
   * conditional UPDATE, returning whether THIS caller won the claim. Mirrors {@link claimDeleteJob}, but
   * archive is the TERMINAL, in-place lifecycle (the row + transcript + analytics + /context all survive):
   * the guard is `status <> 'archived'`, so a second concurrent archive matches 0 rows and returns false
   * (single-flight). The archived state commits IMMEDIATELY so reads/realtime flip the UI to read-only before
   * the slow physical reclaim ({@link archiveJobDeep}) runs in the background. Org-scoped.
   */
  async claimArchiveJob(jobId: string, orgId: string): Promise<boolean> {
    const res = await this.jobs.update(
      { id: jobId, org_id: orgId, status: Not('archived') },
      { status: 'archived', archived_at: new Date() },
    );
    return (res.affected ?? 0) > 0;
  }

  /**
   * A TRUTHFUL reclaim of a job's two EXPENSIVE artifacts (container + worktree) — the disk cost archive is
   * after. Deliberately does NOT reuse {@link closeJob}: closeJob swallows teardown / worktree-remove failures
   * and STILL writes `lifecycle='closed'`, so a silent failure would masquerade as reclaimed and never retry,
   * leaving disk on an archived job forever. Instead run BOTH reclaims while TRACKING success, and only mark
   * the sandbox `closed` when both genuinely succeeded. Returns whether the reclaim truly completed — `false`
   * leaves `lifecycle` non-`closed` so {@link reconcileArchivedSandboxes} retries. Idempotent: a `closed`
   * (or absent) row owes nothing.
   */
  async reclaimJobArtifacts(jobId: string, orgId: string): Promise<boolean> {
    const row = await this.sandboxes.findOne({
      where: { job_id: jobId, org_id: orgId },
    });
    if (!row || row.lifecycle === 'closed') return true; // nothing owed
    let ok = true;
    // The container side is truthful — `teardownByIdentity` REJECTS on failure (unlike `removeSandbox`).
    try {
      await this.sandboxProvider.teardownByIdentity({
        sandbox: await this.rowToSandbox(row),
        orgId,
        jobId,
      });
    } catch (err) {
      ok = false;
      this.logger.warn(
        `archive: container teardown failed for ${jobId}: ${err}`,
      );
    }
    if (row.worktree_path) {
      const repo = await this.repoForRow(row).catch(() => null);
      if (repo) {
        try {
          await this.git.removeSandbox(repo, row.worktree_path);
        } catch (err) {
          ok = false;
          this.logger.warn(
            `archive: worktree remove threw for ${jobId}: ${err}`,
          );
        }
      }
      // `LocalGitService.removeSandbox` SWALLOWS its rm / `git worktree remove` failures and RESOLVES — its
      // resolve is NOT proof of removal. Trust the filesystem: if the worktree dir still exists, reclaim did
      // not happen → do not mark closed → the reconciler retries.
      if (existsSync(row.worktree_path)) {
        ok = false;
        this.logger.warn(
          `archive: worktree still present after remove for ${jobId}`,
        );
      }
    }
    if (ok) {
      await this.sandboxes.update(
        { id: row.id },
        { container_id: null, lifecycle: 'closed' },
      );
    }
    return ok; // false ⇒ lifecycle stays non-closed ⇒ reconciler retries
  }

  /**
   * The PHYSICAL side of archiving — {@link deleteJobDeep} MINUS the row delete and MINUS the /context removal
   * (decision d2). Reclaim the container + worktree TRUTHFULLY ({@link reclaimJobArtifacts} — that is what
   * gates the reconciler retry, since they are the disk cost), best-effort-drop /playground + the redundant
   * on-disk session JSONL, release any onboarding-spawn marker, and wake dependents. The jobs row + transcript
   * + analytics + /context all SURVIVE. Fully idempotent (teardown-by-identity, worktree remove, and the dir
   * removals all no-op / `force:true`), so {@link reconcileArchivedSandboxes} can safely re-run it. Assumes
   * the status was already flipped to `archived` by {@link claimArchiveJob}.
   */
  async archiveJobDeep(jobId: string, orgId: string): Promise<void> {
    await this.reclaimJobArtifacts(jobId, orgId); // container + worktree — gates the reconciler retry
    this.removeJobPlaygroundDir(orgId, jobId); // best-effort, small; NOT /context (kept — decision d2)
    this.removeOnDiskSessionJsonl(jobId); // best-effort; redundant with transcript_messages (decision d4)

    // Release the onboarding-spawn marker so a re-connect can re-onboard (a dangling pointer would block
    // re-spawn forever) — same as the hard-delete path.
    await this.projects
      .update(
        { org_id: orgId, onboarding_job_id: jobId },
        { onboarding_job_id: null },
      )
      .catch(() => undefined);

    // Wake any job blocked on this one — `archived` is now a terminal blocker resolution, so a dependent
    // doesn't strand forever on a blocker that will never merge (archive replaced the cascade-delete that
    // used to make the blocker row vanish).
    await this.jobDeps
      .onBlockerResolved(jobId, 'archived')
      .catch((err) =>
        this.logger.warn(
          `archiveJobDeep: wake funnel failed for blocker ${jobId}: ${err}`,
        ),
      );
  }

  /**
   * The AUTO-ARCHIVE sweep (replaces the old 7-day merged-sandbox disk GC): archive every merged/closed job
   * idle longer than {@link archiveInactivityTtlMs} — anchored on its LAST TRANSCRIPT ACTIVITY
   * (`MAX(transcript_messages.created_at)`, NOT `jobs.updated_at`, which background reconcilers bump without
   * real activity). A job with zero transcript rows (`MAX` is NULL) does NOT match — NULL fails `<`, the safe
   * default (it needs a manual archive). Set-based eligibility query, then claim-then-archive per job
   * (best-effort). Drains the detached-worktree backlog on the first sweeps. Leader-only (runs from the reap
   * timer). Returns how many it archived.
   */
  async archiveInactiveJobs(): Promise<number> {
    const cutoff = new Date(Date.now() - this.archiveInactivityTtlMs);
    const rows = await this.jobs
      .createQueryBuilder('j')
      .select(['j.id', 'j.org_id'])
      .where('j.status <> :arch', { arch: 'archived' })
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
        this.logger.warn(
          `archiveInactiveJobs: archive of job ${j.id} failed: ${err}`,
        );
      }
    }
    if (archived)
      this.logger.log(`archiveInactiveJobs: archived ${archived} idle job(s)`);
    return archived;
  }

  /**
   * Durable RECLAIM RETRY for archive — the self-heal for an interrupted {@link archiveJobDeep}. Unlike
   * `deleting`, archive commits `status='archived'` IMMEDIATELY (for instant read-only), so there is no
   * transient marker a sweep re-picks; without this a crash mid-reclaim would leave an archived job with its
   * worktree/container on disk forever, silently defeating the disk goal. Find already-archived jobs whose
   * sandbox is not yet fully `closed` — a TRUTHFUL signal now that {@link reclaimJobArtifacts} only writes
   * `closed` on genuine success — and re-run the idempotent {@link archiveJobDeep}. Run leader-only from the
   * reap timer AND on boot (like {@link reconcileDeletingJobs}). Returns how many it re-attempted.
   */
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

  // ── reaping / reconciliation (driven by DriverModule's boot hook + interval) ────────────────────

  /**
   * Finish any job stranded mid-delete — a job left in `status='deleting'` because the process crashed
   * between {@link claimDeleteJob} and the background {@link deleteJobDeep} completing. Re-runs the full
   * teardown (idempotent: `closeJob` no-ops a closed sandbox, `jobs.delete` no-ops a gone row). Best-effort
   * per job. Run leader-only on boot + from the reap interval so a stuck delete self-heals without a
   * restart. Returns how many jobs it swept.
   */
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
        this.logger.warn(
          `reconcileDeletingJobs: finishing delete of job ${job.id} failed: ${err}`,
        );
      }
    }
    if (swept)
      this.logger.log(
        `reconcileDeletingJobs: finished ${swept} stranded delete(s)`,
      );
    return swept;
  }

  /**
   * Apply an authoritative GitHub PR state to a job: terminal `pr_state` write (authoritative sidebar
   * glyph), retire any live "Merge PR" card, and wake blockers. Merge NO LONGER tears down the sandbox
   * (decision d5) — a merged/closed job stays fully interactive so the operator can follow up after merge;
   * the container's RAM is freed by the idle reaper (`reapIdle`) and the worktree/container are reclaimed
   * only at ARCHIVE (`archiveInactiveJobs` after >TTL idle, or a manual archive). Idempotent — an `open`
   * state is a no-op; `gone` (PR/repo deleted) folds to `closed`. Always returns `'noop'` (nothing is torn
   * down here anymore). Shared by the `pull_request` webhook (fast path) and `pollPrClosures` (30-min
   * backstop) so they can't drift.
   */
  async applyGithubPrState(
    job: JobEntity,
    state: 'open' | 'merged' | 'closed' | 'gone',
  ): Promise<'noop'> {
    if (state === 'open') return 'noop';
    const prState = state === 'gone' ? 'closed' : state; // 'merged' | 'closed'
    await this.jobs.update({ id: job.id }, { pr_state: prState });
    // Retire any live "Merge PR" card now the PR is terminal — the shared point every terminal path funnels
    // through, so a PR merged/closed by any means (github.com, a click, a poll) can't leave a stale button.
    if (this.driverStore) {
      await this.driverStore
        .neutralizeMergeCard(
          job.id,
          prState === 'merged' ? 'merged' : 'not-ready',
        )
        .catch(() => undefined);
    }
    await this.jobDeps
      .onBlockerResolved(
        job.id,
        prState === 'merged' ? 'merged' : 'closed_unmerged',
      )
      .catch((err) =>
        this.logger.warn(
          `applyGithubPrState: wake funnel failed for blocker ${job.id}: ${err}`,
        ),
      );
    return 'noop';
  }

  /**
   * Poll the PR of every non-archived thread that has one (the PR lives on the THREAD now) whose sandbox
   * isn't `closed`; when it has merged or closed (or was deleted), stamp the terminal `pr_state` (via
   * `applyGithubPrState`). Merge no longer tears anything down here (decision d5) — this is now purely the
   * authoritative-state backstop the webhook fast path mirrors. Best-effort per thread. Returns how many
   * threads it transitioned to a terminal PR state.
   */
  async pollPrClosures(): Promise<number> {
    const threads = await this.jobs.find({
      where: { pr_number: Not(IsNull()), status: Not('archived') },
    });
    let applied = 0;
    for (const thread of threads) {
      try {
        const sandbox = await this.sandboxes.findOne({
          where: { job_id: thread.id },
        });
        // Skip already-terminal jobs: a closed sandbox, OR a job whose `pr_state` is already merged/closed
        // (state already applied — the lifecycle-only guard would otherwise re-poll + re-apply + re-count it
        // every 30 min forever, since merge no longer flips the sandbox to `closed`).
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
        this.logger.debug(
          `pollPrClosures: thread ${thread.id} check failed: ${err}`,
        );
      }
    }
    if (applied)
      this.logger.log(
        `pollPrClosures: recorded ${applied} terminal PR state(s)`,
      );
    return applied;
  }

  /** Remove a job's durable host-side `/playground` scratch dir — it lives OUTSIDE the worktree (keyed by
   *  jobId), so neither `closeJob` nor a worktree removal touches it. Best-effort; never throws. Reclaimed by
   *  BOTH hard delete ({@link deleteJobDeep}) and archive ({@link archiveJobDeep}). */
  private removeJobPlaygroundDir(orgId: string, jobId: string): void {
    const dir = this.sandboxProvider.playgroundDirHost(orgId, jobId);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      this.logger.warn(
        `removeJobPlaygroundDir: remove failed for ${dir}: ${err}`,
      );
    }
  }

  /** Remove a job's durable host-side `/context` dir (specs/artifacts/evidence) — same out-of-worktree,
   *  keyed-by-jobId nature as `/playground`. Best-effort; never throws. Reclaimed ONLY by hard delete
   *  ({@link deleteJobDeep}); archive KEEPS /context on the box (decision d2), so it does NOT call this. */
  private removeJobContextDir(orgId: string, jobId: string): void {
    const dir = this.sandboxProvider.contextDirHost(orgId, jobId);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      this.logger.warn(`removeJobContextDir: remove failed for ${dir}: ${err}`);
    }
  }

  /** Best-effort removal of a job's REDUNDANT on-disk Claude session JSONL (the durable copy lives in
   *  `transcript_messages` — decision d4). `teardownByIdentity` reclaims the container but NOT the host-side
   *  agent-home dir that holds the transcript, so archive drops it explicitly via the sandbox provider's
   *  existing `brainTranscriptProjectsDir` accessor. Null (nothing on disk yet) is a no-op; never throws. */
  private removeOnDiskSessionJsonl(jobId: string): void {
    const dir = this.sandboxProvider.brainTranscriptProjectsDir(jobId);
    if (!dir) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      this.logger.warn(
        `removeOnDiskSessionJsonl: remove failed for ${dir}: ${err}`,
      );
    }
  }

  /**
   * Reap the CONTAINER (not the worktree) of every `attached` thread that has been idle past the TTL and
   * is not mid-turn → flip it to `detached`. The durable worktree + branch + session stay; the next turn
   * re-attaches (cold) with the reset notice. Returns how many were reaped.
   */
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
    if (reaped)
      this.logger.log(`reapIdle: detached ${reaped} idle sandbox container(s)`);
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
    if (res.affected)
      this.logger.log(
        `boot reconcile: marked ${res.affected} thread sandbox(es) detached`,
      );
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
  ): Promise<
    { reset: true } | { reset: false; reason: 'no-container' | 'busy' }
  > {
    const row = await this.sandboxes.findOne({
      where: { job_id: jobId, org_id: orgId },
    });
    if (!row || row.lifecycle === 'closed' || !row.container_id) {
      return { reset: false, reason: 'no-container' };
    }
    if (this.activity.isBusy(row.container_id))
      return { reset: false, reason: 'busy' };
    await this.detachContainer(row, 'reset');
    return { reset: true };
  }

  /** Tear down a row's container (best-effort) and flip it to `detached`. Worktree untouched. */
  private async detachContainer(
    row: JobSandboxEntity,
    reason: 'idle' | 'reset',
  ): Promise<void> {
    // Drop any `running` turn row bound to this container BEFORE tearing it down: the engine is about to
    // die, so a lingering `running` row would make the steer path treat it as a live turn and XADD the
    // operator's next message into an unread input stream (silently lost) until the watchdog's stale
    // window cleans it. Best-effort — the durable delivery pump's liveness probe is the primary guard.
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
        this.logger.debug(
          `detachContainer(${reason}): failRunningForJob failed (ignored): ${err}`,
        ),
      );
    await this.sandboxProvider
      .teardown(await this.rowToSandbox(row))
      .catch((err) => {
        this.logger.warn(
          `detachContainer(${reason}): teardown failed for thread ${row.job_id}: ${err}`,
        );
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
      const branched = await this.git.switchBranch(
        baseSandboxInput,
        projectRepo,
        featureBranch,
      );

      // Populate git submodules into the freshly cut worktree (no-op without a `.gitmodules`) so the
      // in-sandbox build can resolve submodule-provided packages (e.g. `@workspace/*`). `git worktree add`
      // does NOT do this; auth rides the org PAT just like the clone. Fail-soft.
      await this.git.ensureSubmodules(branched.worktreePath, projectRepo);

      // Hydrate the freshly-cut worktree (granted secrets + cache mounts) and attach the
      // execution environment (thread-keyed container). forceHydrate: the worktree is brand new.
      const { sandbox: attached, hydrationSig } =
        await this.provisioner.provisionAndAttach({
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
      await this.jobs.update(
        { id: thread.id },
        { feature_branch: featureBranch },
      );

      this.logger.log(
        `provisioned sandbox for thread ${thread.id} on ${featureBranch}: worktree=${attached.worktreePath}` +
          (attached.containerId
            ? ` container=${attached.containerId.slice(0, 12)}`
            : ' (local)'),
      );

      // A brand-new job whose setup script failed on this cold create halts here. The specific error is
      // already persisted durably on the sandbox row (`setup_error`) and surfaced to the operator, who
      // retries/steers it directly — the build driver no longer wakes the brain to auto-fix it.
      if (row.setup_error) {
        this.logger.warn(
          `setup script failed on cold bring-up for thread ${thread.id} — recorded (setup_error); awaiting operator`,
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

  /** Resolve the `ProjectRepo` (clone path + token) for a sandbox row — keyed by the repo's SLUG. */
  private async repoForRow(row: JobSandboxEntity): Promise<ProjectRepo> {
    const project = await this.projects.findOne({ where: { id: row.repo_id } });
    if (!project)
      throw new Error(`No repos row for id=${row.repo_id} (org=${row.org_id})`);
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
  private async ensureWorktree(
    row: JobSandboxEntity,
    projectRepo: ProjectRepo,
  ): Promise<void> {
    if (row.worktree_path && existsSync(row.worktree_path)) return;
    const sb = await this.recutWorktree(row, projectRepo);
    this.logger.log(
      `restored missing worktree for thread ${row.job_id} at ${sb.worktreePath}`,
    );
  }

  /**
   * Cut the job's durable worktree from scratch on its OWN branch (`current_branch` → `feature_branch`),
   * restoring the branch from origin for a full clone ({@link LocalGitService.switchBranch}), and re-populate
   * submodules. Sets `row.worktree_path` and returns the resulting sandbox. Shared by {@link ensureWorktree}
   * (crash recovery) and {@link hardResetSandbox} (operator/onboarding from-scratch reset). A submodule repo
   * is cut as a full clone here (`hasSubmodules ? createBaseClone : createBaseWorktree`), so a hard reset also
   * heals a checkout that was previously mis-cut as a linked worktree.
   */
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
      desired &&
      (await this.git.refExists(base.worktreePath, `refs/heads/${desired}`))
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
  ): Promise<
    { reset: true } | { reset: false; reason: 'no-container' | 'busy' }
  > {
    const row = await this.sandboxes.findOne({
      where: { job_id: jobId, org_id: orgId },
    });
    if (!row || row.lifecycle === 'closed')
      return { reset: false, reason: 'no-container' };
    if (row.container_id && this.activity.isBusy(row.container_id)) {
      return { reset: false, reason: 'busy' };
    }
    const projectRepo = await this.repoForRow(row);

    // Tear the container down (best-effort → `detached`), then blow the worktree away. The next
    // `ensureContainer` sees the missing worktree, re-cuts + force-hydrates it, and cold-attaches (`wasReset`).
    await this.detachContainer(row, 'reset');
    await this.git.removeSandbox(projectRepo, row.worktree_path);
    this.logger.log(
      `hard-reset sandbox for thread ${jobId} — worktree removed; next attach re-cuts from scratch`,
    );
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
      thread?.feature_branch ??
      thread?.base_branch ??
      project?.default_branch ??
      'main';
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
