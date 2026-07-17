import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddJobHalted1783539243443 implements MigrationInterface {
  name = 'AddJobHalted1783539243443';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" ADD "halted" boolean NOT NULL DEFAULT false`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "halted"`);
  }
}
