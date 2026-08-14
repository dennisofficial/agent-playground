import { Injectable } from "@nestjs/common";
import {
  EAttentionScope,
  attentionFor,
  unionFacts,
  type Attention,
  type AttentionFacts,
} from "../domain/attention.js";
import { EThreadStatus } from "../generated/prisma/enums.js";
import { JobRepository, type JobRow } from "../store/job.repository.js";
import {
  ThreadRepository,
  type ThreadFacts,
} from "../store/thread.repository.js";
import { TransitionRepository } from "../store/transition.repository.js";

/**
 * The two writes behind "what needs you": when you last reached the bottom of a thread, and whether
 * a job is on the shelf.
 *
 * They live together because they are the same question from opposite ends — one is how a row
 * starts asking for you, the other is how you tell it to stop. Neither belongs on
 * `WorkspaceService`, which is about creating and destroying work rather than about noticing it.
 */
@Injectable()
export class AttentionService {
  constructor(
    private readonly threadRepository: ThreadRepository,
    private readonly jobRepository: JobRepository,
    private readonly transitionRepository: TransitionRepository,
  ) {}

  /**
   * Where a job stands the instant one of its turns ended — the read behind a desktop notification.
   *
   * `runningThreadIds` is the caller's LOCAL lane set and is passed in rather than read, which is
   * the whole design: a turn belongs to the process holding its lane, so this answers "is the ball
   * with the human" from the point of view of the only instance entitled to ask. Threads another
   * terminal is running are absent from that set and therefore counted as idle here — correct,
   * because that terminal will notify for them itself.
   *
   * Composed from existing reads rather than one clever query. It runs once when a turn ends, not
   * per frame, so three small reads is the cheaper thing to own.
   */
  async jobAttentionAfterTurn(args: {
    threadId: string;
    runningThreadIds: readonly string[];
  }): Promise<{ jobId: string; jobTitle: string; attention: Attention } | null> {
    const job = await this.jobRepository.findByThreadId(args.threadId);
    if (!job) return null;

    const [threads, pending] = await Promise.all([
      this.threadRepository.listForJob(job.id),
      this.transitionRepository.pendingForJob(job.id),
    ]);

    const proposalPending = pending.length > 0;
    const hasPullRequest = job.prNumber !== null;

    // `unseen` is deliberately false throughout: it is the only fact `attentionFor` does not consult
    // when choosing a verb (it draws the dot), and a notification fires on a TRANSITION rather than
    // on a backlog. Reading it would be more queries to change nothing.
    const facts = threads.map<AttentionFacts>((thread) => ({
      turnRunning: args.runningThreadIds.includes(thread.id),
      proposalPending,
      openThreadCount: thread.status === EThreadStatus.closed ? 0 : 1,
      unseen: false,
      hasPullRequest,
    }));

    return {
      jobId: job.id,
      jobTitle: job.title,
      attention: attentionFor({
        // The two job-level facts are re-applied ON TOP of the union rather than trusted to survive
        // it, exactly as `jobAttention` does: `unionFacts` folds a per-thread array, so a job whose
        // threads have all been deleted would otherwise lose both to an empty `.some()`.
        facts: { ...unionFacts(facts), proposalPending, hasPullRequest },
        scope: EAttentionScope.job,
      }),
    };
  }

  /**
   * You reached the bottom of this thread at `at`. Called on reaching it and again on every message
   * that arrives while you are still there — so a thread you are watching never accumulates unread,
   * and no "is this page focused" special case is needed anywhere.
   */
  async markSeen(args: { threadId: string; at: Date }): Promise<void> {
    await this.threadRepository.markSeen(args);
  }

  /** Hides. Touches no file, closes no thread, reclaims nothing — restore is lossless by design. */
  async archiveJob(jobId: string): Promise<void> {
    await this.jobRepository.setArchived({ jobId, archived: true });
  }

  async restoreJob(jobId: string): Promise<void> {
    await this.jobRepository.setArchived({ jobId, archived: false });
  }

  async listArchivedJobs(projectId: string | null): Promise<JobRow[]> {
    return this.jobRepository.listArchived(projectId);
  }

  /**
   * The same facts one level up. The projects list unions them exactly as a job unions its threads
   * — the roll-up is one function all the way to the top, not a rule per level.
   */
  async threadFactsByProject(): Promise<Map<string, ThreadFacts[]>> {
    return this.threadRepository.factsByProject();
  }
}
