import { Injectable, Logger } from '@nestjs/common';
import {
  baseBranchRefusal,
  rebaseFailedMessage,
  shipBranch,
  shippedReply,
  type PullRequestRef,
} from '../domain/ship.js';
import { JobRepository } from '../store/job.repository.js';
import { GitService } from './git.service.js';
import { GithubCliService } from './github-cli.service.js';
import type { ShipActions, ToolContext } from './tools/tool.js';

/** The remote a ship turn pushes to. One name, in one place — a repository with two is out of v1. */
const REMOTE = 'origin';

/**
 * `ship_pr`: rebase onto the base branch, push, and open a pull request **only if none is open**.
 *
 * Its own service rather than a verb on `ThreadSeamService` because it moves nothing structural —
 * no phase, no thread, no cursor. It is the same shape as `TaskService`: something a thread does
 * that Atlas records, held by the seam rather than implemented there.
 *
 * **Idempotent on purpose.** A red build is handled by starting a new phase, so this runs more than
 * once per job, and every step is written to be safe the second time: the rebase is onto whatever
 * the base is now, the push carries a lease, and the pull request is created only when the ask came
 * back empty. That is what makes re-shipping the identical operation, needing no second role and no
 * amend path.
 *
 * **It ships; it does not watch.** Nothing here polls, and nothing waits for a build — a watcher
 * earns its keep by noticing things while you are away, and this is a terminal you have open or you
 * don't. `Job.prNumber` is a render cache, not a synced state.
 */
@Injectable()
export class ShipService implements ShipActions {
  private readonly logger = new Logger(ShipService.name);

  constructor(
    private readonly gitService: GitService,
    private readonly githubCliService: GithubCliService,
    private readonly jobRepository: JobRepository,
  ) {}

  /**
   * Throws with a sentence the agent can act on, rather than answering with one. A failed ship is
   * genuinely a failure — the pull request does not exist — and the tool layer turns a throw into an
   * `isError` result, which is the one form the model reliably does not narrate as success.
   */
  async ship(args: { ctx: ToolContext; title: string; body: string }): Promise<string> {
    const { job, cwd } = args.ctx;

    const decided = shipBranch({
      jobBranch: job.branch,
      headBranch: await this.gitService.currentBranch(cwd),
    });
    if (!decided.ok) throw new Error(decided.reason);
    const branch = decided.branch;

    // Before anything is fetched: a rebase refuses over uncommitted work anyway, and finding out
    // after the fetch would say so in git's words rather than in one the agent can act on.
    if (await this.gitService.isDirty(cwd)) {
      throw new Error(
        'there is uncommitted work in this worktree — commit it (or discard it) first. A rebase will not run over it, and a pull request cannot carry it.',
      );
    }

    const base = await this.githubCliService.defaultBranch(cwd);
    const refusal = baseBranchRefusal({ branch, base });
    if (refusal) throw new Error(refusal);

    await this.rebase({ cwd, base });

    const pushed = await this.gitService.push({ cwd, remote: REMOTE, branch });
    if (!pushed.ok) {
      throw new Error(`git push failed: ${pushed.stderr.trim() || pushed.stdout.trim()}`);
    }

    const { pr, created } = await this.pullRequest({ cwd, branch, base, ...args });
    await this.cachePullRequest({ jobId: job.id, pr });
    return shippedReply({ branch, base, pr, created });
  }

  private async rebase(args: { cwd: string; base: string }): Promise<void> {
    const fetched = await this.gitService.fetch({
      cwd: args.cwd,
      remote: REMOTE,
      branch: args.base,
    });
    if (!fetched.ok) {
      throw new Error(
        `git fetch ${REMOTE} ${args.base} failed: ${fetched.stderr.trim() || fetched.stdout.trim()}`,
      );
    }

    const rebased = await this.gitService.rebaseOnto({
      cwd: args.cwd,
      upstream: `${REMOTE}/${args.base}`,
    });
    if (!rebased.ok) {
      throw new Error(rebaseFailedMessage({ base: args.base, stderr: rebased.stderr }));
    }
  }

  /**
   * Ask first, create second — the one ordering that makes this whole tool re-runnable. A pull
   * request that already exists has just been updated by the push above, which is why there is no
   * update call here at all.
   */
  private async pullRequest(args: {
    cwd: string;
    branch: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ pr: PullRequestRef; created: boolean }> {
    const existing = await this.githubCliService.openPullRequest({
      cwd: args.cwd,
      branch: args.branch,
    });
    if (existing) return { pr: existing, created: false };

    const pr = await this.githubCliService.createPullRequest({
      cwd: args.cwd,
      base: args.base,
      head: args.branch,
      title: args.title,
      body: args.body,
    });
    return { pr, created: true };
  }

  /**
   * Written on every ship, not only on the one that created it: the number is a render cache, so a
   * job whose pull request was opened by hand — or before this field had a writer — picks it up on
   * the next ship. And a cache that fails to write must not fail a pull request that exists.
   */
  private async cachePullRequest(args: { jobId: string; pr: PullRequestRef }): Promise<void> {
    try {
      await this.jobRepository.setPullRequest({
        jobId: args.jobId,
        prNumber: args.pr.number,
      });
    } catch (error) {
      this.logger.error(`caching pr #${args.pr.number} failed: ${String(error)}`);
    }
  }
}
