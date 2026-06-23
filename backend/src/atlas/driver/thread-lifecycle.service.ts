import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { existsSync } from 'node:fs';
import { IsNull, Not, Repository } from 'typeorm';
import type { FeatureSandbox, ProjectRepo } from '../git';
import { GithubPrService, LocalGitService, parseGithubRepoUrl } from '../git';
import { CredentialResolver } from '../onboarding';
import { OnboardingService, type BindChannelArgs } from '../onboarding';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import { AtlasProject, AtlasThread, AtlasThreadSandbox } from '../persistence/entities';
import { hostExecUser, SANDBOX_PROVIDER, SandboxActivityRegistry, type SandboxProvider } from '../sandbox';
import { ATLAS_DRIVER_REPO, type DriverRepoResolver } from './repo-resolver';

/** Default idle window before an attached-but-quiet container is reaped to `detached` (12h). */
const DEFAULT_IDLE_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Sandbox lifecycle status strings (mirrors the entity comment).
 */
export type ThreadSandboxLifecycle = 'provisioning' | 'attached' | 'detached' | 'closed';

/** Input to `createThread` — everything needed to open a new workspace thread. */
export interface CreateThreadInput {
  teamId: string;
  projectId: string;
  /** HTTPS GitHub URL for the project (required on first use; omit if the project is already registered). */
  repoUrl?: string;
  /** The base branch the operator picked (default = repo's default branch). */
  baseBranch?: string;
  /** Short display title for the thread. */
  displayName?: string;
}

/** The key output of a `createThread` call. */
export interface CreatedThread {
  threadId: string;
  threadSandboxId: string;
  worktreePath: string;
  baseBranch: string;
}

/**
 * R2 — the EXPLICIT CREATE-THREAD control path + per-thread sandbox lifecycle. A thread owns a DURABLE
 * worktree + feature branch + engine session; its container is a DISPOSABLE cache attached on demand.
 *
 *   1. `createThread` — upsert the project/channel binding, persist the `atlas_threads` row, then
 *      provision the sandbox: cut the worktree AND the thread's feature branch (`atlas/thread-<id>`)
 *      at create, attach a thread-keyed container → `lifecycle = attached`.
 *   2. `ensureContainer` — every turn (chat brain + build driver) calls this first: reuses the warm
 *      container, or re-attaches a cold one against the durable worktree (`detached` → `attached`),
 *      returning `wasReset` so a resumed turn is told its runtime is fresh.
 *   3. `reapIdle` / `evictForCapacity` — detach idle/over-cap containers (worktree survives).
 *   4. `closeThread` / `pollPrClosures` — terminal cleanup (PR merged or operator close).
 *
 * The inbound-derived path (ChatStimulusBridge → TriageService) keeps working unchanged — it skips
 * this service entirely and the driver falls back to the legacy per-feature worktree path when no
 * sandbox row is found.
 */
@Injectable()
export class ThreadLifecycleService {
  private readonly logger = new Logger(ThreadLifecycleService.name);

  constructor(
    @InjectRepository(AtlasThread, ATLAS_CONNECTION)
    private readonly threads: Repository<AtlasThread>,
    @InjectRepository(AtlasThreadSandbox, ATLAS_CONNECTION)
    private readonly sandboxes: Repository<AtlasThreadSandbox>,
    @InjectRepository(AtlasProject, ATLAS_CONNECTION)
    private readonly projects: Repository<AtlasProject>,
    private readonly onboarding: OnboardingService,
    private readonly git: LocalGitService,
    private readonly pr: GithubPrService,
    private readonly creds: CredentialResolver,
    private readonly env: EnvService,
    private readonly activity: SandboxActivityRegistry,
    @Inject(ATLAS_DRIVER_REPO) private readonly repos: DriverRepoResolver,
    @Inject(SANDBOX_PROVIDER) private readonly sandboxProvider: SandboxProvider,
  ) {}

  /**
   * Create a new thread: persist the thread + project/channel binding + provision the sandbox (worktree
   * + feature branch cut at create, container attached). Returns immediately after the sandbox is marked
   * `attached` (docker DinD wait included in `SandboxProvider.attach`).
   */
  async createThread(input: CreateThreadInput): Promise<CreatedThread> {
    const { teamId, projectId, displayName } = input;

    // 1. Ensure the project exists (upsert via onboarding, no-op if already registered).
    if (input.repoUrl) {
      const bindArgs: BindChannelArgs = {
        teamId,
        projectId,
        channelRef: projectId, // placeholder — threads don't need a surface channel ref
        repoUrl: input.repoUrl,
        ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
        displayName: displayName ?? projectId,
      };
      await this.onboarding.bindChannel(bindArgs);
    }

    // Resolve the project's registered base branch (falls back to the project row's default_branch).
    const project = await this.projects.findOne({ where: { team_id: teamId, project_id: projectId } });
    if (!project) {
      throw new Error(`No atlas_projects row for team=${teamId} project=${projectId} — pass repoUrl to register it`);
    }
    const baseBranch = input.baseBranch ?? project.default_branch ?? 'main';

    // 2. Persist the atlas_threads row (origin='control', base_branch set).
    const thread = await this.threads.save(
      this.threads.create({
        team_id: teamId,
        project_id: projectId,
        origin: 'control',
        surface_thread_ref: null,
        title: displayName ?? null,
        base_branch: baseBranch,
      }),
    );
    this.logger.log(`created thread ${thread.id} for ${teamId}/${projectId} on ${baseBranch}`);

    // 3. Provision the sandbox on the base branch.
    const sandboxRow = await this.provisionSandbox(thread, project, baseBranch);

    return {
      threadId: thread.id,
      threadSandboxId: sandboxRow.id,
      worktreePath: sandboxRow.worktree_path,
      baseBranch,
    };
  }

  /**
   * Look up the sandbox row for a thread, returning its current `FeatureSandbox` (or null if none
   * exists). Read-only (no attach) — used where a live container isn't required (e.g. plan-review). Turn
   * paths use {@link ensureContainer} instead, which (re-)attaches.
   */
  async findSandbox(threadId: string, teamId: string): Promise<FeatureSandbox | null> {
    const row = await this.sandboxes.findOne({ where: { thread_id: threadId, team_id: teamId } });
    if (!row) return null;
    return this.rowToSandbox(row);
  }

  // ── private helpers ───────────────────────────────────────────────────────────────────────────

  /**
   * (Re-)attach a live container for a thread, on demand. The worktree + branch + session are durable;
   * the container is a disposable cache. Returns the live `FeatureSandbox` and `wasReset` — true when a
   * COLD container was attached (created fresh, or restarted from stopped: any background processes from
   * prior turns are gone). Callers prepend a "sandbox was reset" notice to a RESUMED turn when wasReset.
   *
   * Returns null if the thread has no sandbox row or it is already `closed`. Self-heals a missing
   * worktree (crash / host-down) by recreating it on the feature branch before attaching.
   */
  async ensureContainer(
    threadId: string,
    teamId: string,
  ): Promise<{ sandbox: FeatureSandbox; wasReset: boolean } | null> {
    const row = await this.sandboxes.findOne({ where: { thread_id: threadId, team_id: teamId } });
    if (!row || row.lifecycle === 'closed') return null;

    // Common path: the durable worktree is present → skip the repo resolve (a git fetch) entirely. Only
    // resolve + restore when it's actually gone (crash / host-down / pruned).
    if (!row.worktree_path || !existsSync(row.worktree_path)) {
      await this.ensureWorktree(row, await this.repoForRow(row));
    }

    // If we're at the global cap and this thread has no live container yet, evict the least-recently
    // active idle one to make room (never a busy thread).
    if (!row.container_id) await this.evictForCapacity();

    const attached = await this.sandboxProvider.attach({
      sandbox: this.rowToSandbox(row),
      teamId,
      threadId,
    });

    const wasReset = attached.warm === false;
    row.worktree_path = attached.worktreePath;
    row.container_id = attached.containerId ?? null;
    row.lifecycle = 'attached';
    row.last_active_at = new Date();
    await this.sandboxes.save(row);

    if (wasReset) this.logger.log(`thread ${threadId} re-attached a COLD container — turn will be told the sandbox reset`);
    return { sandbox: attached, wasReset };
  }

  /**
   * Terminal cleanup — tear down the container AND remove the worktree, flip the row to `closed`. Called
   * on PR merge / explicit thread close / abandon. Idempotent: a `closed` row is a no-op. Leaves the
   * branch ref (the PR/merge owns it). Best-effort on each side so a half-gone sandbox still closes.
   */
  async closeThread(threadId: string, teamId: string): Promise<void> {
    const row = await this.sandboxes.findOne({ where: { thread_id: threadId, team_id: teamId } });
    if (!row || row.lifecycle === 'closed') return;

    if (row.container_id) {
      await this.sandboxProvider.teardown(this.rowToSandbox(row)).catch((err) => {
        this.logger.warn(`closeThread: teardown failed for thread ${threadId}: ${err}`);
      });
    }
    if (row.worktree_path) {
      const projectRepo = await this.repoForRow(row).catch(() => null);
      if (projectRepo) {
        await this.git.removeSandbox(projectRepo, row.worktree_path).catch((err) => {
          this.logger.warn(`closeThread: worktree remove failed for thread ${threadId}: ${err}`);
        });
      }
    }

    row.container_id = null;
    row.lifecycle = 'closed';
    await this.sandboxes.save(row);
    this.logger.log(`closed thread ${threadId} (container + worktree torn down)`);
  }

  /** Record the thread's PR (url + number) when the build opens it, so the cleanup poll can watch it. */
  async recordPr(threadId: string, teamId: string, prUrl: string, prNumber: number): Promise<void> {
    await this.sandboxes.update(
      { thread_id: threadId, team_id: teamId },
      { pr_url: prUrl, pr_number: prNumber },
    );
  }

  // ── reaping / reconciliation (driven by DriverModule's boot hook + interval) ────────────────────

  /**
   * Poll the PR of every non-`closed` thread that has one; when it has merged or closed (or was deleted),
   * `closeThread` to reclaim the container + worktree. Best-effort per thread — one failure never stops
   * the sweep. Returns how many threads were closed.
   */
  async pollPrClosures(): Promise<number> {
    const rows = await this.sandboxes.find({
      where: { lifecycle: Not('closed'), pr_number: Not(IsNull()) },
    });
    let closed = 0;
    for (const row of rows) {
      try {
        const project = await this.projects.findOne({
          where: { team_id: row.team_id, project_id: row.project_id },
        });
        const parsed = project ? parseGithubRepoUrl(project.git_url) : null;
        const token = await this.creds.githubToken(row.team_id);
        if (!parsed || !token || row.pr_number == null) continue;
        const state = await this.pr.getPullState(token, {
          owner: parsed.owner,
          repo: parsed.repo,
          number: row.pr_number,
        });
        if (state !== 'open') {
          this.logger.log(`thread ${row.thread_id} PR #${row.pr_number} is ${state} — closing thread`);
          await this.closeThread(row.thread_id, row.team_id);
          closed++;
        }
      } catch (err) {
        this.logger.debug(`pollPrClosures: thread ${row.thread_id} check failed: ${err}`);
      }
    }
    if (closed) this.logger.log(`pollPrClosures: closed ${closed} merged/closed thread(s)`);
    return closed;
  }

  /**
   * Reap the CONTAINER (not the worktree) of every `attached` thread that has been idle past the TTL and
   * is not mid-turn → flip it to `detached`. The durable worktree + branch + session stay; the next turn
   * re-attaches (cold) with the reset notice. Returns how many were reaped.
   */
  async reapIdle(): Promise<number> {
    const ttlMs = Number(this.env.get('ATLAS_SANDBOX_IDLE_TTL_MS')) || DEFAULT_IDLE_TTL_MS;
    const cutoff = Date.now() - ttlMs;
    const rows = await this.sandboxes.find({ where: { lifecycle: 'attached' } });
    let reaped = 0;
    for (const row of rows) {
      if (!row.container_id) continue;
      if (this.activity.isBusy(row.container_id)) continue; // never mid-turn
      if (row.last_active_at && row.last_active_at.getTime() > cutoff) continue; // recently active
      await this.detachContainer(row, 'idle');
      reaped++;
    }
    if (reaped) this.logger.log(`reapIdle: detached ${reaped} idle sandbox container(s)`);
    return reaped;
  }

  /**
   * On boot, mark every non-`closed` row `detached` + null its `container_id`: after a restart no
   * container is confirmed live, so the next turn's `ensureContainer` re-resolves it (reuse-if-alive →
   * warm, recreate-if-gone → cold). The worktree is restored lazily on that next turn (on the FEATURE
   * branch, via `ensureWorktree`). Also rescues half-finished `provisioning` rows.
   */
  async reconcileOnBoot(): Promise<void> {
    const res = await this.sandboxes.update(
      { lifecycle: Not('closed') },
      { lifecycle: 'detached', container_id: null },
    );
    if (res.affected) this.logger.log(`boot reconcile: marked ${res.affected} thread sandbox(es) detached`);
  }

  /** Soft cap: if at/over `ATLAS_MAX_CONCURRENT_SANDBOXES`, detach the least-recently-active idle one. */
  private async evictForCapacity(): Promise<void> {
    const cap = Number(this.env.get('ATLAS_MAX_CONCURRENT_SANDBOXES'));
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
  private async detachContainer(row: AtlasThreadSandbox, reason: 'idle' | 'lru'): Promise<void> {
    await this.sandboxProvider.teardown(this.rowToSandbox(row)).catch((err) => {
      this.logger.warn(`detachContainer(${reason}): teardown failed for thread ${row.thread_id}: ${err}`);
    });
    row.container_id = null;
    row.lifecycle = 'detached';
    await this.sandboxes.save(row);
    this.logger.log(`detached thread ${row.thread_id} container (${reason})`);
  }

  // ── private helpers ───────────────────────────────────────────────────────────────────────────

  private async provisionSandbox(
    thread: AtlasThread,
    project: AtlasProject,
    baseBranch: string,
  ): Promise<AtlasThreadSandbox> {
    // Persist the row in `provisioning` state first (crash-safe: if we fail after this we can detect
    // the orphaned row on recovery).
    const row = await this.sandboxes.save(
      this.sandboxes.create({
        team_id: thread.team_id,
        thread_id: thread.id,
        project_id: project.project_id,
        base_branch: baseBranch,
        feature_branch: null,
        worktree_path: '', // filled in below
        container_id: null,
        lifecycle: 'provisioning',
      }),
    );

    try {
      const token = await this.creds.githubToken(thread.team_id);
      const projectRepo = await this.git.ensureRepo({
        projectId: project.project_id,
        gitUrl: project.git_url,
        defaultBranch: baseBranch,
        ...(token ? { token } : {}),
      });

      // Cut the base-branch worktree, then cut the thread's feature branch IN-PLACE at create — a thread
      // IS a branch from the start (one branch / one PR per thread). The row's feature_branch is the
      // source of truth the driver builds on; no separate build-time branch dance for the web path.
      const featureBranch = `atlas/thread-${thread.id.slice(0, 8)}`;
      const baseSandboxInput = await this.git.createBaseWorktree(projectRepo, thread.id);
      const branched = await this.git.switchBranch(baseSandboxInput, projectRepo, featureBranch);

      // Attach the execution environment (thread-keyed container).
      const attached = await this.sandboxProvider.attach({
        sandbox: branched,
        teamId: thread.team_id,
        threadId: thread.id,
      });

      row.worktree_path = attached.worktreePath;
      row.feature_branch = featureBranch;
      row.container_id = attached.containerId ?? null;
      row.lifecycle = 'attached';
      row.last_active_at = new Date();
      await this.sandboxes.save(row);

      this.logger.log(
        `provisioned sandbox for thread ${thread.id} on ${featureBranch}: worktree=${attached.worktreePath}` +
          (attached.containerId ? ` container=${attached.containerId.slice(0, 12)}` : ' (local)'),
      );
    } catch (err) {
      // Mark detached so a recovery pass / next ensureContainer can re-attach (or closeThread reclaims).
      row.lifecycle = 'detached';
      await this.sandboxes.save(row).catch(() => undefined);
      throw err;
    }

    return row;
  }

  /** Resolve the `ProjectRepo` (clone path + token) for a sandbox row. */
  private async repoForRow(row: AtlasThreadSandbox): Promise<ProjectRepo> {
    const project = await this.projects.findOne({
      where: { team_id: row.team_id, project_id: row.project_id },
    });
    if (!project) throw new Error(`No atlas_projects row for team=${row.team_id} project=${row.project_id}`);
    const token = await this.creds.githubToken(row.team_id);
    return this.git.ensureRepo({
      projectId: row.project_id,
      gitUrl: project.git_url,
      defaultBranch: project.default_branch,
      ...(token ? { token } : {}),
    });
  }

  /**
   * Ensure the row's durable worktree exists on disk, recreating it ON THE FEATURE BRANCH if it has gone
   * (crash / host down / pruned). `createBaseWorktree` lands at the same per-thread path and is
   * idempotent; the feature branch ref lives in the durable shared `.git`, so `switchBranch` checks it
   * out. Updates `row.worktree_path` if it was empty/stale.
   */
  private async ensureWorktree(row: AtlasThreadSandbox, projectRepo: ProjectRepo): Promise<void> {
    if (row.worktree_path && existsSync(row.worktree_path)) return;
    const base = await this.git.createBaseWorktree(projectRepo, row.thread_id);
    const sb = row.feature_branch
      ? await this.git.switchBranch(base, projectRepo, row.feature_branch)
      : base;
    row.worktree_path = sb.worktreePath;
    this.logger.log(`restored missing worktree for thread ${row.thread_id} at ${sb.worktreePath}`);
  }

  /** Convert a persisted `AtlasThreadSandbox` row to an in-memory `FeatureSandbox`. */
  private rowToSandbox(row: AtlasThreadSandbox): FeatureSandbox {
    const execUser = row.container_id ? hostExecUser() : undefined;
    return {
      projectId: row.project_id,
      branch: row.feature_branch ?? row.base_branch,
      worktreePath: row.worktree_path,
      gitUrl: '', // Not stored on the row — resolved lazily when needed (push/PR is repo-level)
      ...(row.container_id ? { containerId: row.container_id } : {}),
      ...(execUser ? { execUser } : {}),
    };
  }
}
