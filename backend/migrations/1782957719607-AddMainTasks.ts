import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMainTasks1782957719607 implements MigrationInterface {
  name = 'AddMainTasks1782957719607';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD "main_tasks" jsonb NOT NULL DEFAULT '[]'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "main_tasks"`);
  }
}
