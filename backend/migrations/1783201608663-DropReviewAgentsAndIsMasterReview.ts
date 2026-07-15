import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Step 6 cleanup: drop the two columns the typed-thread model superseded — `review_agents` (the shared
 * jsonb whose lost-update race is gone now that each review lens is its own `review_lens` child row) and
 * `is_master_review` (subsumed by `kind = 'master_review'`).
 *
 * Hand-edit over the generator: it also wanted to DROP + recreate `uq_threads_job_parent_ordinal` because
 * that index's `NULLS NOT DISTINCT` clause isn't expressible in TypeORM metadata (same discipline as the
 * extensions / HNSW index) — so it reads as "spurious". It is NOT: it's the load-bearing per-parent ordinal
 * uniqueness. The DROP INDEX / CREATE UNIQUE INDEX lines are removed so the index is left untouched.
 */
export class DropReviewAgentsAndIsMasterReview1783201608663 implements MigrationInterface {
  name = 'DropReviewAgentsAndIsMasterReview1783201608663';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "threads" DROP COLUMN "review_agents"`,
    );
    await queryRunner.query(
      `ALTER TABLE "threads" DROP COLUMN "is_master_review"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "threads" ADD "is_master_review" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "threads" ADD "review_agents" jsonb NOT NULL DEFAULT '[]'`,
    );
  }
}
