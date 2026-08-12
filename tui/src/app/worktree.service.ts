import { Injectable } from '@nestjs/common';
import { existsSync } from 'node:fs';
import type { Job } from '../generated/prisma/client.js';
import { JobRepository } from '../store/job.repository.js';
import { branchNameFor, jobCwd, worktreePathFor } from '../domain/worktree.js';
import { GitService } from './git.service.js';

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
export class WorktreeService {
  constructor(
    private readonly gitService: GitService,
    private readonly jobRepository: JobRepository,
  ) {}

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
