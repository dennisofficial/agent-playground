import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddThreadDeviations1783473410742 implements MigrationInterface {
  name = 'AddThreadDeviations1783473410742';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "threads" ADD "deviations" jsonb NOT NULL DEFAULT '[]'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "deviations"`);
  }
}
