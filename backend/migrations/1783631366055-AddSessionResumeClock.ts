import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSessionResumeClock1783631366055 implements MigrationInterface {
  name = 'AddSessionResumeClock1783631366055';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD "session_resume_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(`ALTER TABLE "jobs" ADD "session_resume" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "session_resume"`);
    await queryRunner.query(
      `ALTER TABLE "jobs" DROP COLUMN "session_resume_at"`,
    );
  }
}
