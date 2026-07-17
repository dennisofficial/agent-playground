import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Step 1 of the thread-unification: give `threads` its first-class typed shape — a `kind` column
 * (subsumes `is_master_review`), a `parent_thread_id` self-FK (a builder parents its review-lens /
 * post-review children), a kind-`config` jsonb, and the full `review_findings` a review-lens produces.
 *
 * Hand-edits over the generator (same discipline as the InitAtlasSchema extensions/HNSW index):
 *  - `kind` is added NULLABLE, backfilled from `is_master_review` (→ `master_review`, else `builder`),
 *    then set NOT NULL — an `ADD ... NOT NULL` would fail on the existing rows.
 *  - The old `UNIQUE (job_id, ordinal)` is replaced by a UNIQUE INDEX on
 *    `(job_id, parent_thread_id, ordinal)` declared `NULLS NOT DISTINCT` (PG16) so root rows
 *    (`parent_thread_id IS NULL`) still can't collide on ordinal — TypeORM can't emit `NULLS NOT
 *    DISTINCT`, so it's hand-added here.
 */
export class ThreadKindsAndParent1783199177561 implements MigrationInterface {
  name = 'ThreadKindsAndParent1783199177561';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "threads" DROP CONSTRAINT "uq_threads_job_id_ordinal"`);
    // `kind` NOT NULL would reject the existing rows — add nullable, backfill, then constrain.
    await queryRunner.query(`ALTER TABLE "threads" ADD "kind" text`);
    await queryRunner.query(`ALTER TABLE "threads" ADD "parent_thread_id" uuid`);
    await queryRunner.query(`ALTER TABLE "threads" ADD "config" jsonb NOT NULL DEFAULT '{}'`);
    await queryRunner.query(`ALTER TABLE "threads" ADD "review_findings" jsonb`);
    await queryRunner.query(
      `UPDATE "threads" SET "kind" = CASE WHEN "is_master_review" = true THEN 'master_review' ELSE 'builder' END WHERE "kind" IS NULL`,
    );
    await queryRunner.query(`ALTER TABLE "threads" ALTER COLUMN "kind" SET NOT NULL`);
    await queryRunner.query(
      `CREATE INDEX "idx_threads_parent_thread_id" ON "threads" ("parent_thread_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "threads" ADD CONSTRAINT "fk_threads_parent_thread_id_threads" FOREIGN KEY ("parent_thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    // Replaces UNIQUE (job_id, ordinal). NULLS NOT DISTINCT (PG16) treats the NULL parent_thread_id of
    // every root row as equal, so two root rows still can't share an ordinal within a job; child rows
    // (a builder's review lenses / post-review) get their own ordinal space per parent.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_threads_job_parent_ordinal" ON "threads" ("job_id", "parent_thread_id", "ordinal") NULLS NOT DISTINCT`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."uq_threads_job_parent_ordinal"`);
    await queryRunner.query(
      `ALTER TABLE "threads" DROP CONSTRAINT "fk_threads_parent_thread_id_threads"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_threads_parent_thread_id"`);
    await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "review_findings"`);
    await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "config"`);
    await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "parent_thread_id"`);
    await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "kind"`);
    await queryRunner.query(
      `ALTER TABLE "threads" ADD CONSTRAINT "uq_threads_job_id_ordinal" UNIQUE ("job_id", "ordinal")`,
    );
  }
}
