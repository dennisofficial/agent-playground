import { Injectable, Logger } from "@nestjs/common";
import { deriveJobTitle } from "../domain/job-title.js";
import type { Job } from "../generated/prisma/client.js";
import { JobRepository } from "../store/job.repository.js";
import {
  ConversationService,
  type OpenConversation,
} from "./conversation.service.js";
import { WorkspaceService } from "./workspace.service.js";

export type StartedJob = {
  job: Job;
  cwd: string;
  open: OpenConversation;
};

/**
 * A job that begins with the human's first message, and does not exist before it.
 *
 * This is the whole of "creation without ceremony": until `start()` is called there is no `Job`
 * row, no `Phase`, no `Thread`, no context folder and no worktree — a pending job is UI state on
 * one page, and walking off that page scratches it completely. Everything that used to happen
 * behind a title prompt happens here instead, in the order that makes the first message land as the
 * thread's first message rather than as the second thing said in it.
 *
 * Apart from `WorkspaceService` because it composes three of its own collaborators around one
 * decision, and that service is already at its size limit.
 */
@Injectable()
export class JobStartService {
  private readonly logger = new Logger(JobStartService.name);

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly jobRepository: JobRepository,
    private readonly conversationService: ConversationService,
  ) {}

  async start(args: {
    projectId: string;
    firstMessage: string;
    worktree?: boolean;
  }): Promise<StartedJob> {
    const firstMessage = args.firstMessage.trim();
    // The guard is the invariant, not a validation: a job with no first message is precisely the
    // empty row this ticket exists to make impossible.
    if (firstMessage.length === 0) {
      throw new Error("a job starts with a message");
    }

    const { job, thread } = await this.workspaceService.createJob({
      // Derived, never asked for. See `domain/job-title.ts` — it is a pure function so that a job
      // never waits on a model to be named.
      title: deriveJobTitle(firstMessage),
      projectId: args.projectId,
      ...(args.worktree ? { worktree: true } : {}),
    });

    const row = await this.jobRepository.findWithProject(job.id);
    if (!row) throw new Error(`job ${job.id} vanished as it was created`);
    const cwd = this.workspaceService.cwdFor({
      job,
      projectPath: row.project.path,
    });

    // `openThread` rather than `openJob`: we hold the thread we just made, and it is also what puts
    // `ConversationService` on this conversation so the send below has somewhere to go.
    const open = await this.conversationService.openThread(job, thread, cwd);

    // Sent as a plain `user` message — no harness envelope, no `seed`. The transcript opens on what
    // the human actually typed, which is the point: the first thread is a conversation, not a brief.
    //
    // Not awaited, for the same reason `seedThread` is not: `send()` resolves when the TURN does,
    // and the page must land on the transcript while the agent is still thinking. A failure lands in
    // the thread's store as an error block, where the human is already looking.
    void this.conversationService.send(firstMessage).catch((error: unknown) => {
      this.logger.error(`first turn failed: ${String(error)}`);
    });

    return { job, cwd, open };
  }
}
