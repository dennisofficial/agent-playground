import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PLAN VERSIONING — link each thread to the plan revision (decision record) it belongs to, so a re-propose
 * over already-DONE work can create a NEW revision while the prior revision's threads survive as immutable,
 * browsable history (instead of the old unconditional delete-and-recreate). See `persistPlan`.
 *
 * Hand-edits over the generator:
 *  - Pruned unrelated `workspace_skills` (`review_for_types`/`review_for_globs`) columns the generator also
 *    emitted — those belong to a separate, not-yet-migrated entity change, not this migration.
 *  - Added the BACKFILL: every existing executable thread adopts its job's current `decision_record_id`, so
 *    single-revision jobs behave byte-for-byte as before (the active-revision scoping in `threadsForJob` /
 *    `getPipelineState` still finds them). `main`/`plan_review` stay NULL (revision-agnostic singletons).
 *  - Reshaped `uq_threads_job_parent_ordinal` from (job_id, parent_thread_id, ordinal) to
 *    (job_id, decision_record_id, parent_thread_id, ordinal) — both NULLS NOT DISTINCT (PG16), so two
 *    revisions can reuse ordinals 10/20/30 without colliding. This index's DDL is hand-owned (not TypeORM
 *    metadata), so `migration:generate` never touches it (see the `synchronize:false` decorator).
 */
export class ThreadPlanRevision1783717980494 implements MigrationInterface {
  name = 'ThreadPlanRevision1783717980494';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "threads" ADD "decision_record_id" uuid`,
    );
    // Backfill: executable threads adopt their job's active plan revision; singletons stay NULL.
    await queryRunner.query(
      `UPDATE "threads" t SET "decision_record_id" = j."decision_record_id" ` +
        `FROM "jobs" j WHERE t."job_id" = j."id" AND t."kind" IN ('builder', 'master_review')`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_threads_decision_record_id" ON "threads" ("decision_record_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "threads" ADD CONSTRAINT "fk_threads_decision_record_id_decision_records" FOREIGN KEY ("decision_record_id") REFERENCES "decision_records"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    // Reshape the revision-aware unique index (hand-owned NULLS NOT DISTINCT DDL).
    await queryRunner.query(
      `DROP INDEX "public"."uq_threads_job_parent_ordinal"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_threads_job_parent_ordinal" ON "threads" ("job_id", "decision_record_id", "parent_thread_id", "ordinal") NULLS NOT DISTINCT`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."uq_threads_job_parent_ordinal"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_threads_job_parent_ordinal" ON "threads" ("job_id", "parent_thread_id", "ordinal") NULLS NOT DISTINCT`,
    );
    await queryRunner.query(
      `ALTER TABLE "threads" DROP CONSTRAINT "fk_threads_decision_record_id_decision_records"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_threads_decision_record_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "threads" DROP COLUMN "decision_record_id"`,
    );
  }
}
