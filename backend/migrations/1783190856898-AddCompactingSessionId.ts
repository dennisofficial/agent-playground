import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCompactingSessionId1783190856898 implements MigrationInterface {
  name = 'AddCompactingSessionId1783190856898';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "job_sandboxes" ADD "compacting_session_id" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "job_sandboxes" DROP COLUMN "compacting_session_id"`,
    );
  }
}
