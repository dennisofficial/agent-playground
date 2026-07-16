import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { ThreadGroupEntity, ThreadEntity } from '../persistence/entities';

/** Ordinals are gap-numbered (10, 20, 30…) so a later insert can splice without renumbering. */
const ORDINAL_GAP = 10;

/**
 * job-bootstrap / JobBootstrapService — owns "every job has exactly one `planning` thread group + its single
 * `planner`-role thread from the moment its `JobEntity` row exists" (d7: `thread_group_id` is never null).
 * Moved out of `BrainStoreService` (which still exposes `ensurePlanningThreadGroup` as a thin delegate for its
 * own `persistPlan`/`createFollowUpJob` callers) so every job-creation seam — including the ones outside
 * `BrainModule` (driver/surface/stimulus) — can call it directly without a `BrainModule` import cycle.
 */
@Injectable()
export class JobBootstrapService {
  constructor(
    @InjectRepository(ThreadGroupEntity, DB_CONNECTION)
    private readonly threadGroups: Repository<ThreadGroupEntity>,
    @InjectRepository(ThreadEntity, DB_CONNECTION)
    private readonly threads: Repository<ThreadEntity>,
  ) {}

  /**
   * Ensure the job's ONE `planning` thread group + `planner`-role thread exist (idempotent create-if-absent).
   * The brain's conversation session IS this thread's session, and it anchors the job-level card messages
   * (question/ship/amend/merge) that have no build-lane thread of their own (see
   * `DriverStoreService.planningThreadId`). Safe to call repeatedly — a second call with the thread group already
   * present is a no-op.
   */
  async ensurePlanningThreadGroup(jobId: string, orgId: string): Promise<void> {
    const existing = await this.threadGroups.findOne({
      where: { job_id: jobId, kind: 'planning' },
      order: { ordinal: 'ASC' },
    });
    if (existing) {
      // Heal an interrupted bootstrap (thread group written, thread not) so the planning anchor always resolves.
      const thread = await this.threads.findOne({
        where: { thread_group_id: existing.id },
      });
      if (!thread) await this.createPlanningThread(existing.id, jobId, orgId);
      return;
    }
    const threadGroup = await this.threadGroups.save(
      this.threadGroups.create({
        job_id: jobId,
        org_id: orgId,
        ordinal: ORDINAL_GAP,
        kind: 'planning',
        title: 'Planning',
        config: {},
      }),
    );
    await this.createPlanningThread(threadGroup.id, jobId, orgId);
  }

  /**
   * The job's planning thread group thread id — the anchor for job-level messages that have no build-lane thread
   * of their own. Every job gets exactly one planning thread group with one thread at job start (ensurePlanningThreadGroup
   * above), so this should always resolve; throws loudly rather than letting a caller insert a message with
   * a bogus thread_id if it somehow doesn't.
   */
  async planningThreadId(jobId: string): Promise<string> {
    const threadGroup = await this.threadGroups.findOne({
      where: { job_id: jobId, kind: 'planning' },
      order: { ordinal: 'ASC' },
    });
    const thread = threadGroup
      ? await this.threads.findOne({
          where: { thread_group_id: threadGroup.id },
          order: { ordinal: 'ASC' },
        })
      : null;
    if (!thread)
      throw new Error(
        `job-bootstrap: job ${jobId} has no planning thread group thread to anchor a message`,
      );
    return thread.id;
  }

  /**
   * The job's `ci` thread group thread id, or `null` before it exists (pre-ship — `DriverStoreService.ensureCiThread`
   * is the sole creator, at the post-ship seam). READ-ONLY lookup — never creates one; used by event/CI
   * intake (thread 4 §CI-routing) to decide whether an inbound GitHub/CI stimulus targets the `ci` thread
   * or still falls back to planning. Newest first — an append-only re-plan round (d7) can in principle spawn
   * a later `ci` thread group, and inbound events should always reach the CURRENT one.
   */
  async ciThreadId(jobId: string): Promise<string | null> {
    const thread = await this.threads.findOne({
      where: { job_id: jobId, role: 'ship' },
      order: { ordinal: 'DESC' },
    });
    return thread?.id ?? null;
  }

  /** The planning thread group's single `planner`-role thread — ordinal 0, so builders (gap-numbered after the
   *  highest top-level ordinal) never collide with it on the job-wide UNIQUE(job_id, parent, ordinal). */
  private async createPlanningThread(
    threadGroupId: string,
    jobId: string,
    orgId: string,
  ): Promise<void> {
    await this.threads.save(
      this.threads.create({
        thread_group_id: threadGroupId,
        job_id: jobId,
        org_id: orgId,
        role: 'planner',
        ordinal: 0,
        brief: 'Planner',
        type: 'general',
        status: 'idle',
      }),
    );
  }
}
