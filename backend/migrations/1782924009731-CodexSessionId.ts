import { MigrationInterface, QueryRunner } from 'typeorm';

export class CodexSessionId1782924009731 implements MigrationInterface {
  name = 'CodexSessionId1782924009731';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "plan_reviews" ADD "codex_session_id" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "plan_reviews" DROP COLUMN "codex_session_id"`,
    );
  }
}
