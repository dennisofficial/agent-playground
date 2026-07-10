import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddJobReviewRunning1783600100000 implements MigrationInterface {
  name = 'AddJobReviewRunning1783600100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD "review_running" boolean NOT NULL DEFAULT false`,
    );
    // Backfill: any job whose single codex_reviews row is currently 'running' is mid-review, so the
    // denormalized flag must reflect that on rollout (otherwise a review in flight at deploy time would
    // false-light the "needs you" dot until its next persistRow write).
    await queryRunner.query(
      `UPDATE "jobs" SET "review_running" = true WHERE "id" IN (SELECT "job_id" FROM "codex_reviews" WHERE "status" = 'running')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "review_running"`);
  }
}
