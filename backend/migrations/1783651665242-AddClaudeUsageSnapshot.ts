import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddClaudeUsageSnapshot1783651665242 implements MigrationInterface {
  name = 'AddClaudeUsageSnapshot1783651665242';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "org_credentials" ADD "claude_usage_snapshot" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "org_credentials" DROP COLUMN "claude_usage_snapshot"`);
  }
}
