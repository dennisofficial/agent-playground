import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDoneWakeTracking1783634849573 implements MigrationInterface {
  name = 'AddDoneWakeTracking1783634849573';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "threads" ADD "done_wake_owed" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(`ALTER TABLE "threads" ADD "done_wake_reason" text`);
    await queryRunner.query(`ALTER TABLE "threads" ADD "done_waked_at" TIMESTAMP WITH TIME ZONE`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "done_waked_at"`);
    await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "done_wake_reason"`);
    await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "done_wake_owed"`);
  }
}
