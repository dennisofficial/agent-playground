import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { StageEntity, ThreadEntity } from '../persistence/entities';

/** Ordinals are gap-numbered (10, 20, 30…) so a later insert can splice without renumbering. */
const ORDINAL_GAP = 10;

/**
 * job-bootstrap / JobBootstrapService — owns "every job has exactly one `planning` stage + its single
 * `planning`-role thread from the moment its `JobEntity` row exists" (d7: `stage_id` is never null).
 * Moved out of `BrainStoreService` (which still exposes `ensurePlanningStage` as a thin delegate for its
 * own `persistPlan`/`createFollowUpJob` callers) so every job-creation seam — including the ones outside
 * `BrainModule` (driver/surface/stimulus) — can call it directly without a `BrainModule` import cycle.
 */
@Injectable()
export class JobBootstrapService {
  constructor(
    @InjectRepository(StageEntity, DB_CONNECTION)
    private readonly stages: Repository<StageEntity>,
    @InjectRepository(ThreadEntity, DB_CONNECTION)
    private readonly threads: Repository<ThreadEntity>,
  ) {}

  /**
   * Ensure the job's ONE `planning` stage + `planning`-role thread exist (idempotent create-if-absent).
   * The brain's conversation session IS this thread's session, and it anchors the job-level card messages
   * (question/ship/amend/merge) that have no build-lane thread of their own (see
   * `DriverStoreService.planningThreadId`). Safe to call repeatedly — a second call with the stage already
   * present is a no-op.
   */
  async ensurePlanningStage(jobId: string, orgId: string): Promise<void> {
    const existing = await this.stages.findOne({
      where: { job_id: jobId, kind: 'planning' },
      order: { ordinal: 'ASC' },
    });
    if (existing) {
      // Heal an interrupted bootstrap (stage written, thread not) so the planning anchor always resolves.
      const thread = await this.threads.findOne({ where: { stage_id: existing.id } });
      if (!thread) await this.createPlanningThread(existing.id, jobId, orgId);
      return;
    }
    const stage = await this.stages.save(
      this.stages.create({
        job_id: jobId,
        org_id: orgId,
        ordinal: ORDINAL_GAP,
        kind: 'planning',
        title: 'Planning',
        config: {},
      }),
    );
    await this.createPlanningThread(stage.id, jobId, orgId);
  }

  /**
   * The job's planning-stage thread id — the anchor for job-level messages that have no build-lane thread
   * of their own. Every job gets exactly one planning stage with one thread at job start (ensurePlanningStage
   * above), so this should always resolve; throws loudly rather than letting a caller insert a message with
   * a bogus thread_id if it somehow doesn't.
   */
  async planningThreadId(jobId: string): Promise<string> {
    const stage = await this.stages.findOne({ where: { job_id: jobId, kind: 'planning' }, order: { ordinal: 'ASC' } });
    const thread = stage ? await this.threads.findOne({ where: { stage_id: stage.id }, order: { ordinal: 'ASC' } }) : null;
    if (!thread) throw new Error(`job-bootstrap: job ${jobId} has no planning-stage thread to anchor a message`);
    return thread.id;
  }

  /** The planning stage's single `planning`-role thread — ordinal 0, so builders (gap-numbered after the
   *  highest top-level ordinal) never collide with it on the job-wide UNIQUE(job_id, parent, ordinal). */
  private async createPlanningThread(stageId: string, jobId: string, orgId: string): Promise<void> {
    await this.threads.save(
      this.threads.create({
        stage_id: stageId,
        job_id: jobId,
        org_id: orgId,
        role: 'planning',
        ordinal: 0,
        brief: 'Main',
        type: 'general',
        status: 'pending',
      }),
    );
  }
}
