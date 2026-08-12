import { Injectable } from "@nestjs/common";
import { existsSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import { EPhaseKind, EThreadRole } from "../generated/prisma/enums.js";
import type { Job, Project, Thread } from "../generated/prisma/client.js";
import { ELaunchScope, launchScope } from "../domain/launch-scope.js";
import { jobDir, sessionTapeDir } from "../domain/paths.js";
import { AccountRepository } from "../store/account.repository.js";
import { JobRepository, type JobRow } from "../store/job.repository.js";
import { ProjectRepository } from "../store/project.repository.js";
import { ThreadRepository, type ThreadRow } from "../store/thread.repository.js";
import { ContextFolderService } from "./context-folder.service.js";
import { ConversationService } from "./conversation.service.js";
import { GitService } from "./git.service.js";
import { SessionManagerService } from "./session-manager.service.js";
import { WorktreeService, type JobWorkspace } from "./worktree.service.js";

export type ProjectRow = Project & { jobCount: number; exists: boolean };

@Injectable()
export class WorkspaceService {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly jobRepository: JobRepository,
    private readonly threadRepository: ThreadRepository,
    private readonly accountRepository: AccountRepository,
    private readonly sessionManagerService: SessionManagerService,
    private readonly contextFolderService: ContextFolderService,
    private readonly conversationService: ConversationService,
    private readonly worktreeService: WorktreeService,
    private readonly gitService: GitService,
  ) {}

  async listProjects(): Promise<ProjectRow[]> {
    const projects = await this.projectRepository.list();
    return projects.map((project) => ({
      ...project,
      exists: existsSync(project.path),
    }));
  }

  /**
   * A project is identified by its MAIN worktree, whatever corner of the repository you opened
   * Atlas in. `Project.path` is `@unique`, so without this, opening Atlas inside `.worktrees/foo`
   * would mint a second project with its own job list — and the whole point of worktrees here is
   * that the editor lives in one while Atlas keeps working on the same project.
   */
  async openFolder(path: string): Promise<Project> {
    const absolute = resolve(path);
    if (!existsSync(absolute)) throw new Error(`no such folder: ${absolute}`);
    const root = (await this.gitService.mainWorktree(absolute)) ?? absolute;
    return this.projectRepository.open(root, basename(root));
  }

  /**
   * What `atlas` was pointed at, as a project row or nothing.
   *
   * Null is not a failure — it is the normal result of launching from `~`, and it means "show every
   * job, grouped by project". The asymmetry it encodes is deliberate: a folder NAMED on the command
   * line becomes a project even if git has never heard of it, while an implicit cwd outside any
   * repository creates nothing at all. See `domain/launch-scope.ts`.
   */
  async resolveLaunch(args: {
    explicitPath: string | null;
    cwd: string;
  }): Promise<ProjectRow | null> {
    const target = resolve(args.explicitPath ?? args.cwd);
    // A named folder must exist; a cwd always does, so this only ever fires on `atlas <path>`.
    if (args.explicitPath && !existsSync(target)) {
      throw new Error(`no such folder: ${target}`);
    }

    const gitRoot = await this.gitService.mainWorktree(target);
    const scope = launchScope({
      explicitPath: args.explicitPath,
      cwd: args.cwd,
      gitRoot,
    });
    if (scope.kind === ELaunchScope.global) return null;

    // `scope.path` is already the main worktree, so this opens the project directly rather than
    // going back through `openFolder` and asking git the same question a second time.
    const project = await this.projectRepository.open(
      scope.path,
      basename(scope.path),
    );
    const projects = await this.listProjects();
    return projects.find((row) => row.id === project.id) ?? null;
  }

  /**
   * The project a job belongs to. Needed because the unscoped list spans projects, so opening a row
   * there has to find the path its turns will run in — the list itself only knows the name.
   */
  async findProject(id: string): Promise<ProjectRow | null> {
    const projects = await this.listProjects();
    return projects.find((project) => project.id === id) ?? null;
  }

  /** Null spans every project — the unscoped master list, not a special case of one. */
  async listJobs(projectId: string | null): Promise<JobRow[]> {
    return this.jobRepository.listForProject(projectId);
  }

  /** Every thread of a job, closed ones included — the list is a record you browse, not a roster. */
  async listThreads(jobId: string): Promise<ThreadRow[]> {
    return this.threadRepository.listForJob(jobId);
  }

  /** A fresh read of one job — the thread list re-reads it because the cursor moves under it. */
  async findJob(jobId: string): Promise<Job | null> {
    return this.jobRepository.findById(jobId);
  }

  async projectsWithRunningThreads(
    threadIds: readonly string[],
  ): Promise<string[]> {
    return this.jobRepository.projectIdsForThreads(threadIds);
  }

  /**
   * The job and its first thread, created together and handed back together.
   *
   * The thread comes back rather than being looked up again because the caller opens the
   * conversation on it directly: `job.activeThreadId` is stamped by `openThread` AFTER the row this
   * returns was read, so routing through it would be routing through a stale field.
   *
   * Nothing is seeded here. The first thread of a job opens on the human's own words — see
   * `JobStartService`. `ConversationService.seedThread()` is still how a LATER phase's first thread
   * opens, where there is no human message to open on.
   *
   * `worktree` is the first of the three doors onto an isolated branch — the other two are the
   * build confirm and the tool. It is opt-in: a button-colour change does not need a worktree, and
   * a job without one works in the project path exactly as before.
   */
  async createJob(args: {
    projectId: string;
    title: string;
    worktree?: boolean;
  }): Promise<{ job: Job; thread: Thread }> {
    const { projectId, title } = args;
    // Every job starts in intake with one intake thread — the phase and the role are named
    // separately because they are separate axes, and only their opening values coincide.
    const created = await this.jobRepository.create({
      projectId,
      title,
      kind: EPhaseKind.intake,
    });
    const thread = await this.sessionManagerService.openThread(
      created.id,
      EThreadRole.intake,
    );
    this.contextFolderService.ensure(created.id);
    // The branch is named after the job, so the job has to exist first. A worktree that fails to
    // materialise raises here and leaves the job standing in the project path — recoverable
    // through the tool door, where losing the job would not be.
    if (args.worktree) await this.enterWorktree(created.id);

    // Re-read after the worktree: taking one stamps the branch onto the row, and the caller runs
    // the first turn in the directory that branch implies.
    const job = (await this.jobRepository.findById(created.id)) ?? created;
    return { job, thread };
  }

  /**
   * Doors two and three — the build confirm, and the tool at any time — are the same operation as
   * door one, called later. It is idempotent, so calling it on a job that already has a worktree
   * reports the one it has.
   */
  async enterWorktree(jobId: string): Promise<JobWorkspace> {
    const job = await this.jobRepository.findWithProject(jobId);
    if (!job) throw new Error(`no such job: ${jobId}`);
    return this.worktreeService.enter({ job, projectPath: job.project.path });
  }

  /**
   * The facts behind the job page's workspace line. Read here rather than derived in the page
   * because one of them is a `git` call and the other a `stat`, and neither belongs in a render.
   */
  async jobWorkspace(jobId: string): Promise<{
    branch: string | null;
    workspacePath: string | null;
    checkoutBranch: string | null;
    workspaceExists: boolean;
  } | null> {
    const job = await this.jobRepository.findWithProject(jobId);
    // Null rather than a throw: several terminals share one database, so a job can be deleted out
    // from under a page that is looking at it. The list beside this line already degrades to "this
    // job has no threads"; a rejection here would instead wedge the whole page on "loading…".
    if (!job) return null;

    const workspaceExists = job.workspacePath
      ? existsSync(job.workspacePath)
      : false;
    // Ask wherever the job actually runs: in a worktree that is the worktree's own branch, and in
    // place it is whatever the editor has checked out — which is the answer that matters, because
    // that is the branch an agent is about to commit on.
    const at =
      job.workspacePath && workspaceExists
        ? job.workspacePath
        : job.project.path;

    return {
      branch: job.branch,
      workspacePath: job.workspacePath,
      checkoutBranch: await this.gitService.currentBranch(at),
      workspaceExists,
    };
  }

  /** Where this job's turns run — its worktree if it took one, else the project path. */
  cwdFor(args: { job: Job; projectPath: string }): string {
    return this.worktreeService.cwdFor(args);
  }

  async deleteJob(jobId: string): Promise<void> {
    // Before anything is evicted or cascaded: a worktree holding uncommitted work refuses, and the
    // job survives the refusal intact.
    const job = await this.jobRepository.findWithProject(jobId);
    if (job) await this.worktreeService.release({ job, projectPath: job.project.path });

    await this.conversationService.evict(
      [jobId],
      await this.threadIdsFor([jobId]),
    );
    // Read the tape keys BEFORE the cascade — afterwards there is nothing left to ask.
    const engineSessionIds =
      await this.jobRepository.engineSessionIdsFor(jobId);
    await this.jobRepository.remove(jobId);
    this.purge(jobId, engineSessionIds);
  }

  /**
   * Worktrees are deliberately left on disk. Forgetting a project never touches the folder it
   * points at (that is the user's repository), and a project-wide sweep would either eat
   * uncommitted work or refuse to forget a folder over a file Atlas has no business judging.
   */
  async deleteProject(projectId: string): Promise<void> {
    const jobIds = await this.jobRepository.idsForProject(projectId);
    await this.conversationService.evict(
      jobIds,
      await this.threadIdsFor(jobIds),
    );

    const tapes = new Map<string, string[]>();
    for (const jobId of jobIds) {
      tapes.set(jobId, await this.jobRepository.engineSessionIdsFor(jobId));
    }

    await this.projectRepository.remove(projectId);
    for (const [jobId, engineSessionIds] of tapes)
      this.purge(jobId, engineSessionIds);
  }

  private async threadIdsFor(jobIds: readonly string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const jobId of jobIds) {
      const threads = await this.threadRepository.listForJob(jobId);
      ids.push(...threads.map((thread) => thread.id));
    }
    return ids;
  }

  private purge(jobId: string, engineSessionIds: readonly string[]): void {
    rmSync(jobDir(jobId), { recursive: true, force: true });
    for (const id of engineSessionIds) {
      rmSync(sessionTapeDir(id), { recursive: true, force: true });
    }
  }

  async hasAccount(): Promise<boolean> {
    return (await this.accountRepository.count()) > 0;
  }

  async touchProject(id: string): Promise<void> {
    await this.projectRepository.touch(id);
  }
}
