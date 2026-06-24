import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { existsSync } from 'node:fs';
import { IsNull, Not, Repository } from 'typeorm';
import type { FeatureSandbox, ProjectRepo } from '../git';
import { GithubPrService, LocalGitService, parseGithubRepoUrl } from '../git';
import { CredentialResolver } from '../onboarding';
import { DB_CONNECTION } from '../persistence/database.module';
import { RepoEntity, ThreadEntity, ThreadSandboxEntity } from '../persistence/entities';
import { hostExecUser, SANDBOX_PROVIDER, SandboxActivityRegistry, type SandboxProvider } from '../sandbox';
import { DRIVER_REPO, type DriverRepoResolver } from './repo-resolver';

/** Default idle window before an attached-but-quiet container is reaped to `detached` (12h). */
const DEFAULT_IDLE_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Sandbox lifecycle status strings (mirrors the entity comment).
 */
export type ThreadSandboxLifecycle = 'provisioning' | 'attached' | 'detached' | 'closed';

/** Input to `createThread` — everything needed to open a new workspace thread. */
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
 * The THREAD row owns the branch (`base_branch`/`feature_branch`) and PR (`pr_url`/`pr_number`); the
 * `thread_sandboxes` row is pure INFRA (worktree path + container + chat session + lifecycle).
 *
 *   1. `createThread` — persist the `threads` row, then provision the sandbox: cut the worktree AND the
 *      thread's feature branch (`atlas/thread-<id>`) at create, attach a thread-keyed container.
 *   2. `ensureContainer` — every turn calls this first: reuse the warm container, or re-attach a cold
 *      one against the durable worktree, returning `wasReset` so a resumed turn knows its runtime is fresh.
 *   3. `reapIdle` / `evictForCapacity` — detach idle/over-cap containers (worktree survives).
 *   4. `closeThread` / `pollPrClosures` — terminal cleanup (PR merged or operator close).
 */
@Injectable()
export class ThreadLifecycleService {
  private readonly logger = new Logger(ThreadLifecycleService.name);

  constructor(
    @InjectRepository(ThreadEntity, DB_CONNECTION)
    private readonly threads: Repository<ThreadEntity>,
    @InjectRepository(ThreadSandboxEntity, DB_CONNECTION)
    private readonly sandboxes: Repository<ThreadSandboxEntity>,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly projects: Repository<RepoEntity>,
    private readonly git: LocalGitService,
    private readonly pr: GithubPrService,
    private readonly creds: CredentialResolver,
    private readonly env: EnvService,
    private readonly activity: SandboxActivityRegistry,
    @Inject(DRIVER_REPO) private readonly repos: DriverRepoResolver,
    @Inject(SANDBOX_PROVIDER) private readonly sandboxProvider: SandboxProvider,
  ) {}

  /**
   * Create a new thread: persist the thread + provision the sandbox (worktree + feature branch cut at
   * create, container attached). Returns immediately after the sandbox is marked `attached`.
   */
  async createThread(input: CreateThreadInput): Promise<CreatedThread> {
    const { orgId, repoId, displayName } = input;

    // The repo must already be connected (onboarding's connectRepo). Resolve it (scoped to the org) for
    // its base branch.
    const project = await this.projects.findOne({ where: { id: repoId, org_id: orgId } });
    if (!project) {
      throw new Error(`No connected repo id=${repoId} for org=${orgId} — connect it first`);
    }
    const baseBranch = input.baseBranch ?? project.default_branch ?? 'main';

    // Persist the threads row (origin='control', base_branch set on the THREAD).
    const thread = await this.threads.save(
      this.threads.create({
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
      threadId: thread.id,
      threadSandboxId: sandboxRow.id,
      worktreePath: sandboxRow.worktree_path,
      baseBranch,
    };
  }

  /**
   * Look up the sandbox row for a thread, returning its current `FeatureSandbox` (or null if none
   * exists). Read-only (no attach) — used where a live container isn't required (e.g. plan-review).
   */
  async findSandbox(threadId: string, orgId: string): Promise<FeatureSandbox | null> {
    const row = await this.sandboxes.findOne({ where: { thread_id: threadId, org_id: orgId } });
    if (!row) return null;
    return this.rowToSandbox(row);
  }

  // ── private helpers ───────────────────────────────────────────────────────────────────────────

  /**
   * (Re-)attach a live container for a thread, on demand. The worktree + branch + session are durable;
   * the container is a disposable cache. Returns the live `FeatureSandbox` and `wasReset` — true when a
   * COLD container was attached. Returns null if the thread has no sandbox row or it is already `closed`.
   * Self-heals a missing worktree (crash / host-down) by recreating it on the feature branch first.
   */
  async ensureContainer(
    threadId: string,
    orgId: string,
  ): Promise<{ sandbox: FeatureSandbox; wasReset: boolean } | null> {
    const row = await this.sandboxes.findOne({ where: { thread_id: threadId, org_id: orgId } });
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
      sandbox: await this.rowToSandbox(row),
      orgId,
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
  async closeThread(threadId: string, orgId: string): Promise<void> {
    const row = await this.sandboxes.findOne({ where: { thread_id: threadId, org_id: orgId } });
    if (!row || row.lifecycle === 'closed') return;

    if (row.container_id) {
      await this.sandboxProvider.teardown(await this.rowToSandbox(row)).catch((err) => {
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

  // ── reaping / reconciliation (driven by DriverModule's boot hook + interval) ────────────────────

  /**
   * Poll the PR of every thread that has one (the PR lives on the THREAD now) whose sandbox isn't
   * `closed`; when it has merged or closed (or was deleted), `closeThread` to reclaim the container +
   * worktree. Best-effort per thread. Returns how many threads were closed.
   */
  async pollPrClosures(): Promise<number> {
    const threads = await this.threads.find({ where: { pr_number: Not(IsNull()) } });
    let closed = 0;
    for (const thread of threads) {
      try {
        const sandbox = await this.sandboxes.findOne({ where: { thread_id: thread.id } });
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
          await this.closeThread(thread.id, thread.org_id);
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
  private async detachContainer(row: ThreadSandboxEntity, reason: 'idle' | 'lru'): Promise<void> {
    await this.sandboxProvider.teardown(await this.rowToSandbox(row)).catch((err) => {
      this.logger.warn(`detachContainer(${reason}): teardown failed for thread ${row.thread_id}: ${err}`);
    });
    row.container_id = null;
    row.lifecycle = 'detached';
    await this.sandboxes.save(row);
    this.logger.log(`detached thread ${row.thread_id} container (${reason})`);
  }

  // ── private helpers ───────────────────────────────────────────────────────────────────────────

  private async provisionSandbox(
    thread: ThreadEntity,
    project: RepoEntity,
    baseBranch: string,
  ): Promise<ThreadSandboxEntity> {
    // Persist the row in `provisioning` state first (crash-safe: if we fail after this we can detect
    // the orphaned row on recovery).
    const row = await this.sandboxes.save(
      this.sandboxes.create({
        org_id: thread.org_id,
        thread_id: thread.id,
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

      // Attach the execution environment (thread-keyed container).
      const attached = await this.sandboxProvider.attach({
        sandbox: branched,
        orgId: thread.org_id,
        threadId: thread.id,
      });

      row.worktree_path = attached.worktreePath;
      row.container_id = attached.containerId ?? null;
      row.lifecycle = 'attached';
      row.last_active_at = new Date();
      await this.sandboxes.save(row);

      // Record the feature branch on the THREAD (single owner).
      await this.threads.update({ id: thread.id }, { feature_branch: featureBranch });

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

  /** Resolve the `ProjectRepo` (clone path + token) for a sandbox row — keyed by the repo's SLUG. */
  private async repoForRow(row: ThreadSandboxEntity): Promise<ProjectRepo> {
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
  private async ensureWorktree(row: ThreadSandboxEntity, projectRepo: ProjectRepo): Promise<void> {
    if (row.worktree_path && existsSync(row.worktree_path)) return;
    const thread = await this.threads.findOne({ where: { id: row.thread_id } });
    const base = await this.git.createBaseWorktree(projectRepo, row.thread_id);
    const sb = thread?.feature_branch
      ? await this.git.switchBranch(base, projectRepo, thread.feature_branch)
      : base;
    row.worktree_path = sb.worktreePath;
    this.logger.log(`restored missing worktree for thread ${row.thread_id} at ${sb.worktreePath}`);
  }

  /**
   * Convert a persisted `ThreadSandboxEntity` row to an in-memory `FeatureSandbox`. The branch comes from
   * the THREAD (single owner of feature/base branch); the on-disk repo identity is the repo's SLUG.
   */
  private async rowToSandbox(row: ThreadSandboxEntity): Promise<FeatureSandbox> {
    const thread = await this.threads.findOne({ where: { id: row.thread_id } });
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
