import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Domain vocabulary rename: the CONTAINER `Thread`→`Job` and the lane `Track`→`Thread`. A colliding
 * two-way rename, so everything is done CONTAINER-FIRST (frees the `thread`/`threads` namespace before the
 * lane reuses it). Hand-written because TypeORM's migration:generate emits DROP+CREATE for renames (data
 * loss) — this uses `ALTER … RENAME`, matching the precedent `RenameSectionPhaseToTrackStep`.
 *
 * Tables:  threads→jobs · tracks→threads · thread_sandboxes→job_sandboxes
 * Columns: every container FK thread_id→job_id (+ origin_thread_id→origin_job_id, onboarding_thread_id→
 *          onboarding_job_id) · lane FK steps.track_id→thread_id · decision_records.track_titles→
 *          thread_titles · repo_decisions.source_thread→source_job
 * Constraints/indexes renamed to the CustomNamingStrategy convention so a future generate stays clean.
 * NOT touched (not domain): threads.surface_thread_ref, *.session_id (SDK), git "tracked".
 */
export class RenameThreadToJobTrackToThread1782900000000 implements MigrationInterface {
  name = 'RenameThreadToJobTrackToThread1782900000000';

  public async up(q: QueryRunner): Promise<void> {
    // ═══ COLUMNS ═══ (steps: container thread_id→job_id BEFORE lane track_id→thread_id)
    await q.query(
      `ALTER TABLE "active_turns" RENAME COLUMN "thread_id" TO "job_id"`,
    );
    await q.query(
      `ALTER TABLE "decision_records" RENAME COLUMN "thread_id" TO "job_id"`,
    );
    await q.query(
      `ALTER TABLE "messages" RENAME COLUMN "thread_id" TO "job_id"`,
    );
    await q.query(
      `ALTER TABLE "plan_reviews" RENAME COLUMN "thread_id" TO "job_id"`,
    );
    await q.query(
      `ALTER TABLE "stimuli" RENAME COLUMN "thread_id" TO "job_id"`,
    );
    await q.query(`ALTER TABLE "steps" RENAME COLUMN "thread_id" TO "job_id"`);
    await q.query(
      `ALTER TABLE "steps" RENAME COLUMN "track_id" TO "thread_id"`,
    );
    await q.query(`ALTER TABLE "tracks" RENAME COLUMN "thread_id" TO "job_id"`);
    await q.query(
      `ALTER TABLE "thread_sandboxes" RENAME COLUMN "thread_id" TO "job_id"`,
    );
    await q.query(
      `ALTER TABLE "tickets" RENAME COLUMN "origin_thread_id" TO "origin_job_id"`,
    );
    await q.query(
      `ALTER TABLE "repos" RENAME COLUMN "onboarding_thread_id" TO "onboarding_job_id"`,
    );
    await q.query(
      `ALTER TABLE "decision_records" RENAME COLUMN "track_titles" TO "thread_titles"`,
    );
    await q.query(
      `ALTER TABLE "repo_decisions" RENAME COLUMN "source_thread" TO "source_job"`,
    );

    // ═══ TABLES ═══ (threads→jobs frees "threads" for tracks→threads)
    await q.query(`ALTER TABLE "threads" RENAME TO "jobs"`);
    await q.query(`ALTER TABLE "thread_sandboxes" RENAME TO "job_sandboxes"`);
    await q.query(`ALTER TABLE "tracks" RENAME TO "threads"`);

    // ═══ CONSTRAINTS — container (jobs, was threads) ═══
    await q.query(
      `ALTER TABLE "jobs" RENAME CONSTRAINT "pk_threads" TO "pk_jobs"`,
    );
    await q.query(
      `ALTER TABLE "jobs" RENAME CONSTRAINT "fk_threads_org_id_organizations" TO "fk_jobs_org_id_organizations"`,
    );
    await q.query(
      `ALTER TABLE "jobs" RENAME CONSTRAINT "fk_threads_repo_id_repos" TO "fk_jobs_repo_id_repos"`,
    );
    await q.query(
      `ALTER TABLE "jobs" RENAME CONSTRAINT "fk_threads_decision_record_id_decision_records" TO "fk_jobs_decision_record_id_decision_records"`,
    );
    await q.query(
      `ALTER TABLE "jobs" RENAME CONSTRAINT "fk_threads_ticket_id_tickets" TO "fk_jobs_ticket_id_tickets"`,
    );
    // child FKs → jobs
    await q.query(
      `ALTER TABLE "active_turns" RENAME CONSTRAINT "fk_active_turns_thread_id_threads" TO "fk_active_turns_job_id_jobs"`,
    );
    await q.query(
      `ALTER TABLE "decision_records" RENAME CONSTRAINT "fk_decision_records_thread_id_threads" TO "fk_decision_records_job_id_jobs"`,
    );
    await q.query(
      `ALTER TABLE "messages" RENAME CONSTRAINT "fk_messages_thread_id_threads" TO "fk_messages_job_id_jobs"`,
    );
    await q.query(
      `ALTER TABLE "plan_reviews" RENAME CONSTRAINT "fk_plan_reviews_thread_id_threads" TO "fk_plan_reviews_job_id_jobs"`,
    );
    await q.query(
      `ALTER TABLE "stimuli" RENAME CONSTRAINT "fk_stimuli_thread_id_threads" TO "fk_stimuli_job_id_jobs"`,
    );
    await q.query(
      `ALTER TABLE "steps" RENAME CONSTRAINT "fk_steps_thread_id_threads" TO "fk_steps_job_id_jobs"`,
    );
    await q.query(
      `ALTER TABLE "tickets" RENAME CONSTRAINT "fk_tickets_origin_thread_id_threads" TO "fk_tickets_origin_job_id_jobs"`,
    );
    // job_sandboxes (was thread_sandboxes)
    await q.query(
      `ALTER TABLE "job_sandboxes" RENAME CONSTRAINT "pk_thread_sandboxes" TO "pk_job_sandboxes"`,
    );
    await q.query(
      `ALTER TABLE "job_sandboxes" RENAME CONSTRAINT "fk_thread_sandboxes_thread_id_threads" TO "fk_job_sandboxes_job_id_jobs"`,
    );
    await q.query(
      `ALTER TABLE "job_sandboxes" RENAME CONSTRAINT "fk_thread_sandboxes_repo_id_repos" TO "fk_job_sandboxes_repo_id_repos"`,
    );
    await q.query(
      `ALTER TABLE "job_sandboxes" RENAME CONSTRAINT "fk_thread_sandboxes_org_id_organizations" TO "fk_job_sandboxes_org_id_organizations"`,
    );

    // ═══ CONSTRAINTS — lane (threads, was tracks) ═══
    await q.query(
      `ALTER TABLE "threads" RENAME CONSTRAINT "pk_tracks" TO "pk_threads"`,
    );
    await q.query(
      `ALTER TABLE "threads" RENAME CONSTRAINT "fk_tracks_thread_id_threads" TO "fk_threads_job_id_jobs"`,
    );
    await q.query(
      `ALTER TABLE "threads" RENAME CONSTRAINT "fk_tracks_org_id_organizations" TO "fk_threads_org_id_organizations"`,
    );
    await q.query(
      `ALTER TABLE "threads" RENAME CONSTRAINT "uq_tracks_thread_id_ordinal" TO "uq_threads_job_id_ordinal"`,
    );
    await q.query(
      `ALTER TABLE "steps" RENAME CONSTRAINT "fk_steps_track_id_tracks" TO "fk_steps_thread_id_threads"`,
    );
    await q.query(
      `ALTER TABLE "steps" RENAME CONSTRAINT "uq_steps_track_id_ordinal" TO "uq_steps_thread_id_ordinal"`,
    );

    // ═══ INDEXES — container ═══
    await q.query(
      `ALTER INDEX "idx_threads_org_id_repo_id" RENAME TO "idx_jobs_org_id_repo_id"`,
    );
    await q.query(
      `ALTER INDEX "idx_active_turns_thread_id" RENAME TO "idx_active_turns_job_id"`,
    );
    await q.query(
      `ALTER INDEX "idx_decision_records_thread_id" RENAME TO "idx_decision_records_job_id"`,
    );
    await q.query(
      `ALTER INDEX "idx_messages_thread_id_created_at" RENAME TO "idx_messages_job_id_created_at"`,
    );
    await q.query(
      `ALTER INDEX "idx_plan_reviews_thread_id_round" RENAME TO "idx_plan_reviews_job_id_round"`,
    );
    await q.query(
      `ALTER INDEX "idx_steps_thread_id" RENAME TO "idx_steps_job_id"`,
    );
    await q.query(
      `ALTER INDEX "idx_thread_sandboxes_thread_id" RENAME TO "idx_job_sandboxes_job_id"`,
    );
    // ═══ INDEXES — lane (idx_steps_track_id AFTER idx_steps_thread_id freed above) ═══
    await q.query(
      `ALTER INDEX "idx_tracks_thread_id" RENAME TO "idx_threads_job_id"`,
    );
    await q.query(
      `ALTER INDEX "idx_steps_track_id" RENAME TO "idx_steps_thread_id"`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    // ═══ INDEXES — lane (reverse: idx_steps_thread_id→track_id BEFORE idx_steps_job_id→thread_id) ═══
    await q.query(
      `ALTER INDEX "idx_steps_thread_id" RENAME TO "idx_steps_track_id"`,
    );
    await q.query(
      `ALTER INDEX "idx_threads_job_id" RENAME TO "idx_tracks_thread_id"`,
    );
    // ═══ INDEXES — container ═══
    await q.query(
      `ALTER INDEX "idx_job_sandboxes_job_id" RENAME TO "idx_thread_sandboxes_thread_id"`,
    );
    await q.query(
      `ALTER INDEX "idx_steps_job_id" RENAME TO "idx_steps_thread_id"`,
    );
    await q.query(
      `ALTER INDEX "idx_plan_reviews_job_id_round" RENAME TO "idx_plan_reviews_thread_id_round"`,
    );
    await q.query(
      `ALTER INDEX "idx_messages_job_id_created_at" RENAME TO "idx_messages_thread_id_created_at"`,
    );
    await q.query(
      `ALTER INDEX "idx_decision_records_job_id" RENAME TO "idx_decision_records_thread_id"`,
    );
    await q.query(
      `ALTER INDEX "idx_active_turns_job_id" RENAME TO "idx_active_turns_thread_id"`,
    );
    await q.query(
      `ALTER INDEX "idx_jobs_org_id_repo_id" RENAME TO "idx_threads_org_id_repo_id"`,
    );

    // ═══ CONSTRAINTS — lane ═══
    await q.query(
      `ALTER TABLE "steps" RENAME CONSTRAINT "uq_steps_thread_id_ordinal" TO "uq_steps_track_id_ordinal"`,
    );
    await q.query(
      `ALTER TABLE "steps" RENAME CONSTRAINT "fk_steps_thread_id_threads" TO "fk_steps_track_id_tracks"`,
    );
    await q.query(
      `ALTER TABLE "threads" RENAME CONSTRAINT "uq_threads_job_id_ordinal" TO "uq_tracks_thread_id_ordinal"`,
    );
    await q.query(
      `ALTER TABLE "threads" RENAME CONSTRAINT "fk_threads_org_id_organizations" TO "fk_tracks_org_id_organizations"`,
    );
    await q.query(
      `ALTER TABLE "threads" RENAME CONSTRAINT "fk_threads_job_id_jobs" TO "fk_tracks_thread_id_threads"`,
    );
    await q.query(
      `ALTER TABLE "threads" RENAME CONSTRAINT "pk_threads" TO "pk_tracks"`,
    );
    // ═══ CONSTRAINTS — container ═══
    await q.query(
      `ALTER TABLE "job_sandboxes" RENAME CONSTRAINT "fk_job_sandboxes_org_id_organizations" TO "fk_thread_sandboxes_org_id_organizations"`,
    );
    await q.query(
      `ALTER TABLE "job_sandboxes" RENAME CONSTRAINT "fk_job_sandboxes_repo_id_repos" TO "fk_thread_sandboxes_repo_id_repos"`,
    );
    await q.query(
      `ALTER TABLE "job_sandboxes" RENAME CONSTRAINT "fk_job_sandboxes_job_id_jobs" TO "fk_thread_sandboxes_thread_id_threads"`,
    );
    await q.query(
      `ALTER TABLE "job_sandboxes" RENAME CONSTRAINT "pk_job_sandboxes" TO "pk_thread_sandboxes"`,
    );
    await q.query(
      `ALTER TABLE "tickets" RENAME CONSTRAINT "fk_tickets_origin_job_id_jobs" TO "fk_tickets_origin_thread_id_threads"`,
    );
    await q.query(
      `ALTER TABLE "steps" RENAME CONSTRAINT "fk_steps_job_id_jobs" TO "fk_steps_thread_id_threads"`,
    );
    await q.query(
      `ALTER TABLE "stimuli" RENAME CONSTRAINT "fk_stimuli_job_id_jobs" TO "fk_stimuli_thread_id_threads"`,
    );
    await q.query(
      `ALTER TABLE "plan_reviews" RENAME CONSTRAINT "fk_plan_reviews_job_id_jobs" TO "fk_plan_reviews_thread_id_threads"`,
    );
    await q.query(
      `ALTER TABLE "messages" RENAME CONSTRAINT "fk_messages_job_id_jobs" TO "fk_messages_thread_id_threads"`,
    );
    await q.query(
      `ALTER TABLE "decision_records" RENAME CONSTRAINT "fk_decision_records_job_id_jobs" TO "fk_decision_records_thread_id_threads"`,
    );
    await q.query(
      `ALTER TABLE "active_turns" RENAME CONSTRAINT "fk_active_turns_job_id_jobs" TO "fk_active_turns_thread_id_threads"`,
    );
    await q.query(
      `ALTER TABLE "jobs" RENAME CONSTRAINT "fk_jobs_ticket_id_tickets" TO "fk_threads_ticket_id_tickets"`,
    );
    await q.query(
      `ALTER TABLE "jobs" RENAME CONSTRAINT "fk_jobs_decision_record_id_decision_records" TO "fk_threads_decision_record_id_decision_records"`,
    );
    await q.query(
      `ALTER TABLE "jobs" RENAME CONSTRAINT "fk_jobs_repo_id_repos" TO "fk_threads_repo_id_repos"`,
    );
    await q.query(
      `ALTER TABLE "jobs" RENAME CONSTRAINT "fk_jobs_org_id_organizations" TO "fk_threads_org_id_organizations"`,
    );
    await q.query(
      `ALTER TABLE "jobs" RENAME CONSTRAINT "pk_jobs" TO "pk_threads"`,
    );

    // ═══ TABLES (reverse: threads→tracks BEFORE jobs→threads) ═══
    await q.query(`ALTER TABLE "threads" RENAME TO "tracks"`);
    await q.query(`ALTER TABLE "job_sandboxes" RENAME TO "thread_sandboxes"`);
    await q.query(`ALTER TABLE "jobs" RENAME TO "threads"`);

    // ═══ COLUMNS ═══
    await q.query(
      `ALTER TABLE "repo_decisions" RENAME COLUMN "source_job" TO "source_thread"`,
    );
    await q.query(
      `ALTER TABLE "decision_records" RENAME COLUMN "thread_titles" TO "track_titles"`,
    );
    await q.query(
      `ALTER TABLE "repos" RENAME COLUMN "onboarding_job_id" TO "onboarding_thread_id"`,
    );
    await q.query(
      `ALTER TABLE "tickets" RENAME COLUMN "origin_job_id" TO "origin_thread_id"`,
    );
    await q.query(
      `ALTER TABLE "thread_sandboxes" RENAME COLUMN "job_id" TO "thread_id"`,
    );
    await q.query(`ALTER TABLE "tracks" RENAME COLUMN "job_id" TO "thread_id"`);
    await q.query(
      `ALTER TABLE "steps" RENAME COLUMN "thread_id" TO "track_id"`,
    );
    await q.query(`ALTER TABLE "steps" RENAME COLUMN "job_id" TO "thread_id"`);
    await q.query(
      `ALTER TABLE "stimuli" RENAME COLUMN "job_id" TO "thread_id"`,
    );
    await q.query(
      `ALTER TABLE "plan_reviews" RENAME COLUMN "job_id" TO "thread_id"`,
    );
    await q.query(
      `ALTER TABLE "messages" RENAME COLUMN "job_id" TO "thread_id"`,
    );
    await q.query(
      `ALTER TABLE "decision_records" RENAME COLUMN "job_id" TO "thread_id"`,
    );
    await q.query(
      `ALTER TABLE "active_turns" RENAME COLUMN "job_id" TO "thread_id"`,
    );
  }
}
