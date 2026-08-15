import { Injectable } from '@nestjs/common';
import { existsSync } from 'node:fs';
import type { Job } from '../generated/prisma/client.js';
import { JobRepository } from '../store/job.repository.js';
import {
  branchNameFor,
  isAtlasBranch,
  jobCwd,
  worktreePathFor,
  worktreeTakenReply,
} from '../domain/worktree.js';
import { GitService } from './git.service.js';
import type { ToolContext, WorktreeActions } from './tools/tool.js';

export type JobWorkspace = { branch: string; workspacePath: string };

/**
 * A job's branch and worktree, and the one rule that makes an Atlas-owned worktree tool legal where
 * Claude Code's native one is not: **every move through here writes `Job.workspacePath`**. The
 * native tool relocates the work without telling Atlas, leaving the field pointing at a tree
 * nothing runs in any more.
 *
 * All three doors — job creation, the build confirm, and the tool at any time — are the same
 * operation, `enter()`, which is why none of them needs its own code path.
 */
@Injectable()
export class WorktreeService implements WorktreeActions {
  constructor(
    private readonly gitService: GitService,
    private readonly jobRepository: JobRepository,
  ) {}

  /**
   * Door three, at last: `enter_worktree`, called by an agent mid-thread.
   *
   * The docstring above has named three doors since the feature landed and only two were ever built,
   * so an agent asked for a worktree did the only thing it could — `git worktree add` through the
   * shell — which creates the directory and tells Atlas nothing. `Job.workspacePath` stays null, the
   * jobs list keeps drawing the job under `⌂ here`, and every subsequent turn keeps running in the
   * project tree. That is the exact failure this class exists to make impossible, arriving through
   * the one entrance it had left open.
   *
   * `enter()` does the work; this only resolves the project and puts the answer into words. The
   * words are most of the point — see `worktreeTakenReply`.
   */
  async take(args: { ctx: ToolContext }): Promise<string> {
    // Re-read rather than trusting `ctx.job`. The context is resolved once when the thread OPENS and
    // is fixed for its life, so its `workspacePath` is a snapshot that another thread of the same job
    // — or the human, through the build confirm — may have moved since. `enter()` is idempotent
    // against the row, not against the snapshot.
    const job = await this.jobRepository.findWithProject(args.ctx.job.id);
    if (!job) throw new Error(`no such job: ${args.ctx.job.id}`);

    const before = job.workspacePath;
    const workspace = await this.enter({ job, projectPath: job.project.path });
    return worktreeTakenReply({
      ...workspace,
      // Whether the DIRECTORY THIS THREAD RUNS IN changed, which is the only thing the reply's
      // warning is about. A job re-entering a worktree whose record survived but whose directory did
      // not lands back on the same path, and its turns were already pointed there.
      moved: before !== workspace.workspacePath,
    });
  }

  /**
   * Gives the job a branch and a worktree, and records both. Idempotent: a job already sitting in a
   * live worktree gets it back rather than a second one, so the tool is safe to call at any time —
   * including the time it has already been called.
   */
  async enter(args: { job: Job; projectPath: string }): Promise<JobWorkspace> {
    const { job, projectPath } = args;

    const existing = this.existingWorkspace(job);
    if (existing) return existing;

    if (!(await this.gitService.isRepository(projectPath))) {
      throw new Error(`${projectPath} is not a git repository — no worktree to take`);
    }

    // The branch outlives the directory (a removed worktree keeps its branch), so it is re-derived
    // rather than invented: re-entering a job lands back on the work it left.
    const branch = job.branch ?? branchNameFor({ title: job.title, jobId: job.id });
    const workspacePath =
      job.workspacePath ?? worktreePathFor({ projectPath, title: job.title, jobId: job.id });

    const result = await this.gitService.addWorktree({
      repoPath: projectPath,
      worktreePath: workspacePath,
      branch,
    });
    if (!result.ok) throw new Error(`git worktree add failed: ${result.stderr.trim()}`);

    await this.jobRepository.setWorkspace({ jobId: job.id, branch, workspacePath });
    return { branch, workspacePath };
  }

  /**
   * Where this job's turns run. A job that never took a worktree runs in the project path exactly
   * as before.
   *
   * A recorded worktree that has vanished from disk is an error rather than a fallback: silently
   * dropping back to the project path would run the agent in the tree the worktree existed to keep
   * it out of.
   */
  cwdFor(args: { job: Job; projectPath: string }): string {
    const cwd = jobCwd({ projectPath: args.projectPath, workspacePath: args.job.workspacePath });
    if (!existsSync(cwd)) {
      throw new Error(`this job's worktree is gone: ${cwd}`);
    }
    return cwd;
  }

  /**
   * Stands the job in a worktree that ALREADY EXISTS, on a branch Atlas did not name.
   *
   * The fourth door, and the only one that mints nothing. It needs no git call at all, which is the
   * whole argument for it: `enter()` opens by asking `existingWorkspace()` whether the job is already
   * in a live worktree and hands it straight back if so, `cwdFor` runs turns wherever the field
   * points, and `ShipService` rebases and pushes whatever `Job.branch` says. Every one of those was
   * already true of a branch called `dennis/eng-203-…`; nothing could ever WRITE one.
   *
   * The directory must be there now. Recording a workspace that does not exist would hand the job the
   * one state `cwdFor` throws on, at the moment it is created.
   */
  async adopt(args: { job: Job; branch: string; workspacePath: string }): Promise<JobWorkspace> {
    if (!existsSync(args.workspacePath)) {
      throw new Error(`no such worktree: ${args.workspacePath}`);
    }
    await this.jobRepository.setWorkspace({
      jobId: args.job.id,
      branch: args.branch,
      workspacePath: args.workspacePath,
    });
    return { branch: args.branch, workspacePath: args.workspacePath };
  }

  /**
   * Removes a worktree no job is standing in, refusing while it holds uncommitted or untracked work.
   *
   * The one destructive move with no job behind it, so it re-asks the question the display already
   * answered: a group drawn as `no jobs` is only empty relative to the list you are LOOKING at, and
   * an archived job — or a job another terminal created a second ago — records paths this list never
   * showed. Checking here rather than trusting the row is what makes that a refusal instead of a
   * job losing the tree it runs in.
   */
  async releasePath(args: { repoPath: string; worktreePath: string }): Promise<void> {
    const holder = await this.jobRepository.findByWorkspacePath(args.worktreePath);
    if (holder) {
      throw new Error(`“${holder.title}” is working in that worktree — delete the job instead`);
    }
    if (!existsSync(args.worktreePath)) {
      throw new Error(`no such worktree: ${args.worktreePath}`);
    }
    if (await this.gitService.isDirty(args.worktreePath)) {
      throw new Error(
        `that worktree has uncommitted changes: ${args.worktreePath} — commit or discard them first`,
      );
    }
    const result = await this.gitService.removeWorktree({
      repoPath: args.repoPath,
      worktreePath: args.worktreePath,
    });
    if (!result.ok) throw new Error(`git worktree remove failed: ${result.stderr.trim()}`);
  }

  /**
   * Removes the job's worktree, refusing while it holds uncommitted or untracked work. Called on
   * the way to deleting a job, BEFORE the row goes, so the refusal can still name what it saved.
   */
  async release(args: { job: Job; projectPath: string }): Promise<void> {
    const workspacePath = args.job.workspacePath;
    if (!workspacePath) return;

    if (!existsSync(workspacePath)) {
      // Already gone by some other hand. Clearing the field is the point of this service.
      await this.jobRepository.clearWorkspace(args.job.id);
      return;
    }

    // ADOPTED, not created: the branch carries no `atlas/` prefix, so this directory existed before
    // the job and has to outlive it. Forget it, never remove it — the consent here was "delete this
    // job", which is not consent to delete a tree the human made and may have an editor open on.
    //
    // Before the dirty check on purpose. Nothing is being removed, so uncommitted work in there is
    // not at risk and must not block deleting the job that happened to be pointed at it.
    if (!isAtlasBranch(args.job.branch)) {
      await this.jobRepository.clearWorkspace(args.job.id);
      return;
    }

    if (await this.gitService.isDirty(workspacePath)) {
      throw new Error(
        `this job's worktree has uncommitted changes: ${workspacePath} — commit or discard them first`,
      );
    }

    const result = await this.gitService.removeWorktree({
      repoPath: args.projectPath,
      worktreePath: workspacePath,
    });
    if (!result.ok) throw new Error(`git worktree remove failed: ${result.stderr.trim()}`);
    await this.jobRepository.clearWorkspace(args.job.id);
  }

  private existingWorkspace(job: Job): JobWorkspace | null {
    if (!job.branch || !job.workspacePath) return null;
    if (!existsSync(job.workspacePath)) return null;
    return { branch: job.branch, workspacePath: job.workspacePath };
  }
}
