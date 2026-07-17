import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRepoWebhookWarning1783600000000 implements MigrationInterface {
  name = 'AddRepoWebhookWarning1783600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "repos" ADD "webhook_warning" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "repos" DROP COLUMN "webhook_warning"`);
  }
}
