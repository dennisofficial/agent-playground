import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { existsSync } from 'node:fs';
import { IsNull, Not, Repository } from 'typeorm';
import type { FeatureSandbox, ProjectRepo } from '../git';
import { GithubPrService, LocalGitService, parseGithubRepoUrl } from '../git';
import { CredentialResolver } from '../onboarding';
import { DB_CONNECTION } from '../persistence/database.module';
import { RepoEntity, JobEntity, JobSandboxEntity } from '../persistence/entities';
import {
  hostExecUser,
  SANDBOX_PROVIDER,
  SandboxActivityRegistry,
  type SandboxMilestoneStage,
  type SandboxProvider,
} from '../sandbox';
import { TicketService } from '../tickets';
import { DRIVER_REPO, type DriverRepoResolver } from './repo-resolver';
import { WorktreeProvisioner } from './worktree-provisioner.service';

/** Default idle window before an attached-but-quiet container is reaped to `detached` (12h). */
const DEFAULT_IDLE_TTL_MS = 12 * 60 * 60 * 1000;

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
 *      thread's feature branch (`atlas/thread-<id>`) at create, attach a thread-keyed container.
 *   2. `ensureContainer` — every turn calls this first: reuse the warm container, or re-attach a cold
 *      one against the durable worktree, returning `wasReset` so a resumed turn knows its runtime is fresh.
 *   3. `reapIdle` / `evictForCapacity` — detach idle/over-cap containers (worktree survives).
 *   4. `closeJob` / `pollPrClosures` — terminal cleanup (PR merged or operator close).
 */
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
    private readonly tickets: TicketService,
    // Lazily resolves the brain-module decision-ledger manifest for merge-time reconcile (avoids cycle).
    private readonly moduleRef: ModuleRef,
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

    // Provision the sandbox on the base branch.
    const sandboxRow = await this.provisionSandbox(thread, project, baseBranch);

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
      throw new ProvisioningNotReadyError(
        'This repo isn’t fully connected yet — finish connecting it (validate GitHub access) in settings before starting a thread.',
      );
    }
    const baseBranch = thread.base_branch ?? project.default_branch ?? 'main';
    return this.provisionSandbox(thread, project, baseBranch, onMilestone);
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

    // If we're at the global cap and this thread has no live container yet, evict the least-recently
    // active idle one to make room (never a busy thread).
    if (!row.container_id) await this.evictForCapacity();

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

  async deleteJobDeep(jobId: string, orgId: string): Promise<void> {
    // 1. Reclaim the container + worktree (physical side effects — no DB cascade can do this).
    await this.closeJob(jobId, orgId);

    // 2. Hand any linked ticket back to the board BEFORE the thread row vanishes (its `ticket_id` is the
    //    only way to resolve the ticket). The board's in_progress/in_review lanes are thread-driven, so a
    //    deleted thread would otherwise strand its ticket with no driver. Best-effort — never block teardown.
    await this.tickets.revertForDeletedThread({ orgId, jobId }).catch((err) => {
      this.logger.warn(`deleteJobDeep: ticket revert failed for thread ${jobId}: ${err}`);
    });

    // 2b. If this was a repo's onboarding thread, release the spawn marker so a re-connect can re-onboard
    //     (the marker is a pointer, not an FK — it would otherwise dangle and block re-spawn forever).
    await this.projects
      .update({ org_id: orgId, onboarding_job_id: jobId }, { onboarding_job_id: null })
      .catch(() => undefined);

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
        if (!sandbox || sandbox.lifecycle === 'closed') continue;
        const project = await this.projects.findOne({ where: { id: thread.repo_id } });
        const parsed = project ? parseGithubRepoUrl(project.git_url) : null;
        const token = await this.creds.githubToken(thread.org_id);
        if (!parsed || !token || thread.pr_number == null) continue;
        const state = await this.pr.getPullState(token, {
          owner: parsed.owner,
          repo: parsed.repo,
          number: thread.pr_number,
        });
        if (state !== 'open') {
          this.logger.log(`thread ${thread.id} PR #${thread.pr_number} is ${state} — closing thread`);
          // On MERGE, the thread's promoted decisions are now canonical on the default branch: reconcile
          // the repo's ledger manifest (proposed→accepted + human-edit detection). Reads the base checkout,
          // not this thread's worktree, so it's safe to run before closeJob tears the worktree down.
          if (state === 'merged') {
            await this.reconcileLedgerOnMerge(thread.org_id, thread.repo_id);
            // An onboarding thread's PR adds `.atlas/worktree.json` to the default branch — its merge is
            // what makes the repo's worktree config LIVE, so stamp the repo onboarded now (Codex #4).
            if (thread.kind === 'onboarding') {
              await this.markRepoOnboarded(thread.org_id, thread.repo_id);
            }
          }
          await this.closeJob(thread.id, thread.org_id);
          closed++;
        }
      } catch (err) {
        this.logger.debug(`pollPrClosures: thread ${thread.id} check failed: ${err}`);
      }
    }
    if (closed) this.logger.log(`pollPrClosures: closed ${closed} merged/closed thread(s)`);
    return closed;
  }

  /**
   * Reconcile a repo's decision-ledger manifest after one of its threads' PRs merged — flips merged
   * `proposed` decisions to `accepted` and flags any human edits. Lazily resolved (the manifest lives in
   * the brain module; a dynamic import keeps it out of the driver's module-load cycle). Best-effort.
   */
  private async reconcileLedgerOnMerge(orgId: string, repoId: string): Promise<void> {
    try {
      const { RepoDecisionManifestService } = await import(
        '../brain/repo-decision-manifest.service.js'
      );
      const manifest = this.moduleRef.get(RepoDecisionManifestService, { strict: false });
      await manifest.reconcileFromBaseCheckout(orgId, repoId);
    } catch (err) {
      this.logger.debug(`ledger merge-reconcile failed for repo=${repoId} (continuing): ${err}`);
    }
  }

  /**
   * Reap the CONTAINER (not the worktree) of every `attached` thread that has been idle past the TTL and
   * is not mid-turn → flip it to `detached`. The durable worktree + branch + session stay; the next turn
   * re-attaches (cold) with the reset notice. Returns how many were reaped.
   */
  async reapIdle(): Promise<number> {
    const ttlMs = Number(this.env.get('SANDBOX_IDLE_TTL_MS')) || DEFAULT_IDLE_TTL_MS;
    const cutoff = Date.now() - ttlMs;
    const rows = await this.sandboxes.find({ where: { lifecycle: 'attached' } });
    let reaped = 0;
    for (const row of rows) {
      if (!row.container_id) continue;
      if (this.activity.isBusy(row.container_id)) continue; // never mid-turn (this process)
      // Durable cross-process guard: never reap a container whose thread is mid-turn on ANY instance.
      // `activity` is in-memory/per-process; `turn_active` is the DB-backed signal that survives the
      // brief leader overlap of a rolling deploy (defense-in-depth — the single-leader invariant already
      // means no other process is reaping, but this is cheap insurance).
      const active = await this.jobs.findOne({
        where: { id: row.job_id },
        select: { id: true, turn_active: true },
      });
      if (active?.turn_active) continue;
      if (row.last_active_at && row.last_active_at.getTime() > cutoff) continue; // recently active
      await this.detachContainer(row, 'idle');
      reaped++;
    }
    if (reaped) this.logger.log(`reapIdle: detached ${reaped} idle sandbox container(s)`);
    return reaped;
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

  /** Soft cap: if at/over `MAX_CONCURRENT_SANDBOXES`, detach the least-recently-active idle one. */
  private async evictForCapacity(): Promise<void> {
    const cap = Number(this.env.get('MAX_CONCURRENT_SANDBOXES'));
    if (!cap || cap <= 0) return;
    const attached = await this.sandboxes.find({
      where: { lifecycle: 'attached' },
      order: { last_active_at: 'ASC' },
    });
    const live = attached.filter((r) => r.container_id);
    if (live.length < cap) return;
    // Oldest non-busy live container is the victim. If every one is busy, exceed the cap rather than
    // kill a live turn (soft cap).
    const victim = live.find((r) => r.container_id && !this.activity.isBusy(r.container_id));
    if (!victim) {
      this.logger.warn(`evictForCapacity: at cap (${cap}) but all sandboxes busy — exceeding cap`);
      return;
    }
    await this.detachContainer(victim, 'lru');
  }

  /** Tear down a row's container (best-effort) and flip it to `detached`. Worktree untouched. */
  private async detachContainer(row: JobSandboxEntity, reason: 'idle' | 'lru'): Promise<void> {
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
      const token = await this.creds.githubToken(thread.org_id);
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
      const featureBranch = `atlas/thread-${thread.id.slice(0, 8)}`;
      const baseSandboxInput = await this.git.createBaseWorktree(projectRepo, thread.id);
      const branched = await this.git.switchBranch(baseSandboxInput, projectRepo, featureBranch);

      // Populate git submodules into the freshly cut worktree (no-op without a `.gitmodules`) so the
      // in-sandbox build can resolve submodule-provided packages (e.g. `@workspace/*`). `git worktree add`
      // does NOT do this; auth rides the org PAT just like the clone. Fail-soft.
      await this.git.ensureSubmodules(branched.worktreePath, projectRepo);

      // Hydrate the freshly-cut worktree (granted secrets + golden seed + cache mounts) and attach the
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
      await this.sandboxes.save(row);

      // Record the feature branch on the THREAD (single owner).
      await this.jobs.update({ id: thread.id }, { feature_branch: featureBranch });

      this.logger.log(
        `provisioned sandbox for thread ${thread.id} on ${featureBranch}: worktree=${attached.worktreePath}` +
          (attached.containerId ? ` container=${attached.containerId.slice(0, 12)}` : ' (local)'),
      );
    } catch (err) {
      // Mark detached so a recovery pass / next ensureContainer can re-attach (or closeJob reclaims).
      row.lifecycle = 'detached';
      await this.sandboxes.save(row).catch(() => undefined);
      throw err;
    }

    return row;
  }

  /**
   * Stamp a repo's `onboarded_at` — proof its worktree provisioning config is live. Called by the brain's
   * `finish_onboarding` (secrets-only / nothing to commit) and by `pollPrClosures` when an onboarding
   * thread's `.atlas/worktree.json` PR merges. Idempotent (only stamps when currently null).
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
    if (!project) throw new Error(`No repos row for id=${row.repo_id} (org=${row.org_id})`);
    const token = await this.creds.githubToken(row.org_id);
    return this.git.ensureRepo({
      repoId: project.slug,
      gitUrl: project.git_url,
      defaultBranch: project.default_branch,
      ...(token ? { token } : {}),
    });
  }

  /**
   * Ensure the row's durable worktree exists on disk, recreating it ON THE FEATURE BRANCH (read from the
   * THREAD) if it has gone (crash / host down / pruned). `createBaseWorktree` lands at the same per-thread
   * path and is idempotent; the feature branch ref lives in the durable shared `.git`.
   */
  private async ensureWorktree(row: JobSandboxEntity, projectRepo: ProjectRepo): Promise<void> {
    if (row.worktree_path && existsSync(row.worktree_path)) return;
    const thread = await this.jobs.findOne({ where: { id: row.job_id } });
    const base = await this.git.createBaseWorktree(projectRepo, row.job_id);
    const sb = thread?.feature_branch
      ? await this.git.switchBranch(base, projectRepo, thread.feature_branch)
      : base;
    // A restored worktree is freshly cut → re-populate its submodules (no-op without a `.gitmodules`).
    await this.git.ensureSubmodules(sb.worktreePath, projectRepo);
    row.worktree_path = sb.worktreePath;
    this.logger.log(`restored missing worktree for thread ${row.job_id} at ${sb.worktreePath}`);
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
