import { Injectable } from "@nestjs/common";
import { JobRepository, type JobRow } from "../store/job.repository.js";
import {
  ThreadRepository,
  type ThreadFacts,
} from "../store/thread.repository.js";

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
  ) {}

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

  async listArchivedJobs(projectId: string): Promise<JobRow[]> {
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
