import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddJobActivity1783600200000 implements MigrationInterface {
  name = 'AddJobActivity1783600200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" ADD "activity" text NOT NULL DEFAULT 'idle'`);
    // Best-effort backfill so the window between deploy and the next cold-boot reset reads correctly.
    // plan_review takes precedence over turn (a review runs inside a turn; the more specific wins), so it
    // is applied second and overrides.
    await queryRunner.query(`UPDATE "jobs" SET "activity" = 'turn' WHERE "turn_active" = true`);
    await queryRunner.query(
      `UPDATE "jobs" SET "activity" = 'plan_review' WHERE "review_running" = true`,
    );
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "turn_active"`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "review_running"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" ADD "turn_active" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD "review_running" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(`UPDATE "jobs" SET "turn_active" = ("activity" = 'turn')`);
    await queryRunner.query(`UPDATE "jobs" SET "review_running" = ("activity" = 'plan_review')`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "activity"`);
  }
}
