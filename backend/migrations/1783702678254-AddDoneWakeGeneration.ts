import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDoneWakeGeneration1783702678254 implements MigrationInterface {
  name = 'AddDoneWakeGeneration1783702678254';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "threads" ADD "done_wake_gen" integer NOT NULL DEFAULT '0'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "done_wake_gen"`);
  }
}
