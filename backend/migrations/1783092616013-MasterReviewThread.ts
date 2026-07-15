import { MigrationInterface, QueryRunner } from 'typeorm';

export class MasterReviewThread1783092616013 implements MigrationInterface {
  name = 'MasterReviewThread1783092616013';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "review_agents"`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "tasks"`);
    await queryRunner.query(
      `ALTER TABLE "jobs" DROP COLUMN "pr_review_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "threads" ADD "is_master_review" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "threads" DROP COLUMN "is_master_review"`,
    );
    await queryRunner.query(`ALTER TABLE "jobs" ADD "pr_review_status" text`);
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD "tasks" jsonb NOT NULL DEFAULT '[]'`,
    );
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD "review_agents" jsonb NOT NULL DEFAULT '[]'`,
    );
  }
}
