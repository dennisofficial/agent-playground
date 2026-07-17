import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddJobReviewAgents1782939753290 implements MigrationInterface {
  name = 'AddJobReviewAgents1782939753290';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" ADD "review_agents" jsonb NOT NULL DEFAULT '[]'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "review_agents"`);
  }
}
