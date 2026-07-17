import { MigrationInterface, QueryRunner } from 'typeorm';

export class HaltOutcome1783125246313 implements MigrationInterface {
  name = 'HaltOutcome1783125246313';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "threads" ADD "halt_outcome" text`);
    await queryRunner.query(`ALTER TABLE "threads" ADD "halt_waked_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(
      `ALTER TABLE "threads" ADD "halt_fix_attempts" integer NOT NULL DEFAULT '0'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "halt_fix_attempts"`);
    await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "halt_waked_at"`);
    await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "halt_outcome"`);
  }
}
