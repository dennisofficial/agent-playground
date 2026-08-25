import { Injectable } from '@nestjs/common';
import {
  pullRequestFromUrl,
  pullRequestRefusal,
  recordedReply,
} from '../domain/pull-request.js';
import { JobRepository } from '../store/job.repository.js';
import type { PullRequestActions, ToolContext } from './tools/tool.js';

/**
 * `record_pr`: the agent tells Atlas which pull request this job has, and Atlas writes it down.
 *
 * **This is what is left of shipping, and the smallness is the point.** Atlas used to own the whole
 * act — a `ship_pr` tool that fetched, rebased onto the default branch, force-pushed with a lease
 * and called `gh pr create`, with the agent supplying only a title and a body. That was the harness
 * doing the agent's work on its behalf, and it had the failure mode you would expect: because the
 * rebase was unconditional, every re-ship was a force push, decided by Atlas, invisible to the agent
 * and unarguable with. Shipping is now prose — the `ci` brief says what to do and the agent does it
 * with the shell it already has.
 *
 * So this service runs no git and no `gh`. It is bookkeeping, in the same category as
 * `WorktreeService` writing `Job.workspacePath`: a fact about the job that only Atlas can store,
 * reported by the one party that knows it.
 *
 * Its own service rather than a verb on `ThreadSeamService` for the usual reason — it moves nothing
 * structural, no phase, no thread, no cursor — and because a thing this small is worth keeping
 * separately truthful about what it does.
 */
@Injectable()
export class PullRequestService implements PullRequestActions {
  constructor(private readonly jobRepository: JobRepository) {}

  /**
   * Throws on a URL that is not one. Unlike the render cache this writes — where a failed write must
   * never fail a pull request that exists — being handed nonsense is worth failing on: the tool
   * layer turns a throw into an `isError` result, which is the one form the model reliably does not
   * narrate as success, and a silently-unrecorded PR is a jobs list that lies.
   */
  async record(args: { ctx: ToolContext; url: string }): Promise<string> {
    const pr = pullRequestFromUrl(args.url);
    if (!pr) throw new Error(pullRequestRefusal(args.url));

    // Read through rather than trusting `ctx.job`: the tool context is built when the THREAD opens
    // and a ci thread ships more than once, so the copy it carries is a snapshot that a previous
    // call in this same thread may already have moved past.
    const job = await this.jobRepository.findById(args.ctx.job.id);
    const previous = job?.prNumber ?? null;

    await this.jobRepository.setPullRequest({ jobId: args.ctx.job.id, prNumber: pr.number });
    return recordedReply({ pr, previous });
  }
}
