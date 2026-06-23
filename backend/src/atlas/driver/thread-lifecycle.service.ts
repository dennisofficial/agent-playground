import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { FeatureSandbox } from '../git';
import { LocalGitService } from '../git';
import { CredentialResolver } from '../onboarding';
import { OnboardingService, type BindChannelArgs } from '../onboarding';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import { AtlasProject, AtlasThread, AtlasThreadSandbox } from '../persistence/entities';
import { hostExecUser, SANDBOX_PROVIDER, type SandboxProvider } from '../sandbox';
import { ATLAS_DRIVER_REPO, type DriverRepoResolver } from './repo-resolver';

/**
 * Sandbox lifecycle status strings (mirrors the entity comment).
 */
export type ThreadSandboxLifecycle = 'provisioning' | 'ready' | 'branched' | 'teardown';

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
 * R2 — the EXPLICIT CREATE-THREAD control path. Distinct from today's inbound-message-derived threads
 * (`ChatStimulusBridge`), this service represents the operator-initiated "new thread" operation:
 *
 *   1. Upsert the project/channel binding (delegates to `OnboardingService.bindChannel`).
 *   2. Persist the `atlas_threads` row (origin = 'control', base_branch set).
 *   3. Provision the per-thread sandbox on the BASE branch (`createBaseWorktree` + `SandboxProvider.attach`)
 *      and persist the `atlas_thread_sandboxes` row (`lifecycle = ready`).
 *
 * Subsequent build dispatch calls `ThreadLifecycleService.branchSwitch` to cut the feature branch
 * in-place and flip the row to `lifecycle = branched`, then the driver's `ensureSandbox` reads the
 * persisted sandbox row instead of creating a new per-feature one.
 *
 * The inbound-derived path (ChatStimulusBridge → TriageService) keeps working unchanged — it skips
 * this service entirely and the driver falls back to the old per-feature worktree path when no
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
    private readonly creds: CredentialResolver,
    @Inject(ATLAS_DRIVER_REPO) private readonly repos: DriverRepoResolver,
    @Inject(SANDBOX_PROVIDER) private readonly sandboxProvider: SandboxProvider,
  ) {}

  /**
   * Create a new thread: persist the thread + project/channel binding + provision the base-branch
   * sandbox. Returns immediately after the sandbox is marked `ready` (docker DinD wait included in
   * `SandboxProvider.attach`).
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
   * Branch-switch IN-PLACE: called at approval/build-start. Cuts `featureBranch` off the base in the
   * thread's existing worktree, persists the branch name on the sandbox row, and flips `lifecycle →
   * branched`. Returns the updated `FeatureSandbox` for the driver.
   *
   * Idempotent: if the row is already `branched` to the same branch, returns the existing state.
   */
  async branchSwitch(
    threadId: string,
    teamId: string,
    featureBranch: string,
  ): Promise<FeatureSandbox> {
    const row = await this.sandboxes.findOne({ where: { thread_id: threadId, team_id: teamId } });
    if (!row) {
      throw new Error(`No thread sandbox for thread=${threadId} team=${teamId}`);
    }

    // Idempotent: already branched to this branch.
    if (row.lifecycle === 'branched' && row.feature_branch === featureBranch) {
      this.logger.log(`thread ${threadId} already branched to ${featureBranch} — reusing`);
      return this.rowToSandbox(row);
    }

    // Find the repo to call switchBranch.
    const project = await this.projects.findOne({ where: { team_id: teamId, project_id: row.project_id } });
    if (!project) throw new Error(`No atlas_projects row for team=${teamId} project=${row.project_id}`);
    const token = await this.creds.githubToken(teamId);
    const projectRepo = await this.git.ensureRepo({
      projectId: row.project_id,
      gitUrl: project.git_url,
      defaultBranch: project.default_branch,
      ...(token ? { token } : {}),
    });

    const baseSandbox = this.rowToSandbox(row);
    const switched = await this.git.switchBranch(baseSandbox, projectRepo, featureBranch);

    row.feature_branch = featureBranch;
    row.lifecycle = 'branched';
    await this.sandboxes.save(row);

    this.logger.log(`thread ${threadId} branched to ${featureBranch}`);
    return switched;
  }

  /**
   * Look up the sandbox row for a thread, returning its current `FeatureSandbox` (or null if none
   * exists). Used by `SectionDriver.ensureSandbox` to reuse the per-thread sandbox.
   */
  async findSandbox(threadId: string, teamId: string): Promise<FeatureSandbox | null> {
    const row = await this.sandboxes.findOne({ where: { thread_id: threadId, team_id: teamId } });
    if (!row) return null;
    return this.rowToSandbox(row);
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

      // Cut the base-branch worktree (no new branch — detached at origin/<base>).
      const baseSandboxInput = await this.git.createBaseWorktree(projectRepo, thread.id);

      // Attach the execution environment (no-op in local mode; docker = ensure container).
      const attached = await this.sandboxProvider.attach({
        sandbox: baseSandboxInput,
        teamId: thread.team_id,
      });

      row.worktree_path = attached.worktreePath;
      row.container_id = attached.containerId ?? null;
      row.lifecycle = 'ready';
      await this.sandboxes.save(row);

      this.logger.log(
        `provisioned sandbox for thread ${thread.id}: worktree=${attached.worktreePath}` +
          (attached.containerId ? ` container=${attached.containerId.slice(0, 12)}` : ' (local)'),
      );
    } catch (err) {
      // Mark the row as failed so a recovery pass can clean it up.
      row.lifecycle = 'teardown';
      await this.sandboxes.save(row).catch(() => undefined);
      throw err;
    }

    return row;
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
