import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTaskLists1782951843923 implements MigrationInterface {
  name = 'AddTaskLists1782951843923';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD "tasks" jsonb NOT NULL DEFAULT '[]'`,
    );
    await queryRunner.query(`ALTER TABLE "jobs" ADD "pr_review_status" text`);
    await queryRunner.query(
      `ALTER TABLE "threads" ADD "tasks" jsonb NOT NULL DEFAULT '[]'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "tasks"`);
    await queryRunner.query(
      `ALTER TABLE "jobs" DROP COLUMN "pr_review_status"`,
    );
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "tasks"`);
  }
}
