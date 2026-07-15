import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Rename the first-class pipeline CONTAINER concept from "stage" to "thread_group" (d2/d7 vocabulary):
 * the `stages` table → `thread_groups`, the `threads.stage_id`/`tasks.stage_id` FKs → `thread_group_id`,
 * and every index/constraint carrying the old name → the CustomNamingStrategy name for the new one.
 * Pure rename — no columns added/dropped, no data moved — so a future `migration:generate` stays clean
 * against the renamed entities. RENAME in place everywhere Postgres supports it (cheap, no rebuild).
 */
export class RenameStagesToThreadGroups1784091234567
  implements MigrationInterface
{
  name = 'RenameStagesToThreadGroups1784091234567';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Table
    await queryRunner.query(
      `ALTER TABLE "stages" RENAME TO "thread_groups"`,
    );
    // Columns
    await queryRunner.query(
      `ALTER TABLE "threads" RENAME COLUMN "stage_id" TO "thread_group_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tasks" RENAME COLUMN "stage_id" TO "thread_group_id"`,
    );
    // Indexes
    await queryRunner.query(
      `ALTER INDEX "idx_stages_job_id" RENAME TO "idx_thread_groups_job_id"`,
    );
    await queryRunner.query(
      `ALTER INDEX "idx_stages_job_id_ordinal" RENAME TO "idx_thread_groups_job_id_ordinal"`,
    );
    await queryRunner.query(
      `ALTER INDEX "idx_stages_decision_record_id" RENAME TO "idx_thread_groups_decision_record_id"`,
    );
    await queryRunner.query(
      `ALTER INDEX "idx_threads_stage_id" RENAME TO "idx_threads_thread_group_id"`,
    );
    await queryRunner.query(
      `ALTER INDEX "idx_tasks_stage_id" RENAME TO "idx_tasks_thread_group_id"`,
    );
    await queryRunner.query(
      `ALTER INDEX "idx_tasks_stage_id_ordinal" RENAME TO "idx_tasks_thread_group_id_ordinal"`,
    );
    // Constraints
    await queryRunner.query(
      `ALTER TABLE "thread_groups" RENAME CONSTRAINT "pk_stages" TO "pk_thread_groups"`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_groups" RENAME CONSTRAINT "fk_stages_job_id_jobs" TO "fk_thread_groups_job_id_jobs"`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_groups" RENAME CONSTRAINT "fk_stages_org_id_organizations" TO "fk_thread_groups_org_id_organizations"`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_groups" RENAME CONSTRAINT "fk_stages_decision_record_id_decision_records" TO "fk_thread_groups_decision_record_id_decision_records"`,
    );
    await queryRunner.query(
      `ALTER TABLE "threads" RENAME CONSTRAINT "fk_threads_stage_id_stages" TO "fk_threads_thread_group_id_thread_groups"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tasks" RENAME CONSTRAINT "fk_tasks_stage_id_stages" TO "fk_tasks_thread_group_id_thread_groups"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Constraints
    await queryRunner.query(
      `ALTER TABLE "tasks" RENAME CONSTRAINT "fk_tasks_thread_group_id_thread_groups" TO "fk_tasks_stage_id_stages"`,
    );
    await queryRunner.query(
      `ALTER TABLE "threads" RENAME CONSTRAINT "fk_threads_thread_group_id_thread_groups" TO "fk_threads_stage_id_stages"`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_groups" RENAME CONSTRAINT "fk_thread_groups_decision_record_id_decision_records" TO "fk_stages_decision_record_id_decision_records"`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_groups" RENAME CONSTRAINT "fk_thread_groups_org_id_organizations" TO "fk_stages_org_id_organizations"`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_groups" RENAME CONSTRAINT "fk_thread_groups_job_id_jobs" TO "fk_stages_job_id_jobs"`,
    );
    await queryRunner.query(
      `ALTER TABLE "thread_groups" RENAME CONSTRAINT "pk_thread_groups" TO "pk_stages"`,
    );
    // Indexes
    await queryRunner.query(
      `ALTER INDEX "idx_tasks_thread_group_id_ordinal" RENAME TO "idx_tasks_stage_id_ordinal"`,
    );
    await queryRunner.query(
      `ALTER INDEX "idx_tasks_thread_group_id" RENAME TO "idx_tasks_stage_id"`,
    );
    await queryRunner.query(
      `ALTER INDEX "idx_threads_thread_group_id" RENAME TO "idx_threads_stage_id"`,
    );
    await queryRunner.query(
      `ALTER INDEX "idx_thread_groups_decision_record_id" RENAME TO "idx_stages_decision_record_id"`,
    );
    await queryRunner.query(
      `ALTER INDEX "idx_thread_groups_job_id_ordinal" RENAME TO "idx_stages_job_id_ordinal"`,
    );
    await queryRunner.query(
      `ALTER INDEX "idx_thread_groups_job_id" RENAME TO "idx_stages_job_id"`,
    );
    // Columns
    await queryRunner.query(
      `ALTER TABLE "tasks" RENAME COLUMN "thread_group_id" TO "stage_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "threads" RENAME COLUMN "thread_group_id" TO "stage_id"`,
    );
    // Table
    await queryRunner.query(
      `ALTER TABLE "thread_groups" RENAME TO "stages"`,
    );
  }
}
