import { Inject } from '@nestjs/common';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { z } from 'zod';
import { BoardStore } from '../../memory/board-store';
import { ReviewPipelineService } from '../../sessions/review-pipeline.service';
import {
  SESSION_REGISTRY,
  type SessionRegistry,
} from '../../sessions/session-registry.port';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

const submitForReviewSchema = z.object({
  sessionId: z
    .string()
    .describe('The execute session whose finished work to submit for review.'),
});

/**
 * The single "I'm done coding" gesture — replaces the publish_worktree + open_pr + mark_pr_ready trio
 * the employee used to have to remember. It hands the work to the harness review pipeline: the
 * pipeline reviews this owner's diff (cross-engine), fixes what it can in this session, publishes onto
 * the shared branch, and — once every owner on the ticket has submitted — opens the draft PR, runs a
 * final integration review, and flips it to ready for Dennis. The bot doesn't drive any of that; it
 * just signals completion here. Calling this ENDS YOUR TURN — put a brief first-person heads-up in
 * THIS message's text.
 */
@HarnessTool()
export class SubmitForReviewTool implements IHarnessTool<
  typeof submitForReviewSchema
> {
  readonly name = 'submit_for_review';
  readonly description =
    "Submit your finished execute session for review — your one gesture when the code is done. The harness self-reviews your diff, fixes issues in-session, publishes onto the shared branch, and (once every teammate on the ticket has submitted) opens the PR and marks it ready for Dennis. You do NOT open_pr or mark_pr_ready yourself anymore. Calling this ENDS YOUR TURN, so put any brief heads-up in THIS message's text.";
  readonly schema = submitForReviewSchema;
  readonly terminal = true;

  constructor(
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
    private readonly reviewPipeline: ReviewPipelineService,
    private readonly board: BoardStore,
  ) {}

  async execute(
    { sessionId }: z.infer<typeof submitForReviewSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const session = await this.sessions.get(sessionId);
    if (!session || session.ownerBot !== ctx.identity.selfAgent)
      return `Couldn't submit ${sessionId}: not your session.`;
    if (session.status === 'running')
      return `${sessionId} is mid-turn — wait for it to report back before submitting.`;
    if (session.status === 'closed')
      return `${sessionId} is closed — nothing to submit.`;
    if (session.mode !== 'execute')
      return `${sessionId} isn't an execute session — only finished execution work goes to review.`;
    if (session.boardTaskId === undefined)
      return `${sessionId} isn't linked to a board task — there's no ticket to carry the PR.`;
    const task = await this.board.get(session.team, session.boardTaskId);
    if (!task)
      return `Linked board task #${session.boardTaskId} no longer exists.`;
    if (task.status !== 'executing')
      return `Board task #${session.boardTaskId} is '${task.status}', not 'executing' — only in-flight execution work can be submitted for review.`;

    // Fire-and-forget the pipeline, detached from the chat stream (same as create_session's first
    // turn): it runs long engine review/fix turns and narrates its milestones via board events. Its
    // known dead ends self-report (blocked + seeded), but an UNEXPECTED throw must not vanish as an
    // unhandled rejection — catch it and mark the owner blocked + narrate so the bot still hears back.
    AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () => {
      void this.reviewPipeline.reviewOwner(session).catch((err) => {
        void this.reviewPipeline.reportOwnerCrash(
          session,
          `self-review crashed before it could finish (${err instanceof Error ? err.message : String(err)}) — take it from here`,
        );
      });
    });
    return `Submitted ${sessionId} (#${session.boardTaskId}) for review — self-review is running; I'll report back when the PR is ready or if something needs you.`;
  }
}
