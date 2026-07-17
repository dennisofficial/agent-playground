import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddJobNextPollAt1783598781034 implements MigrationInterface {
  name = 'AddJobNextPollAt1783598781034';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" ADD "next_poll_at" TIMESTAMP WITH TIME ZONE`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "next_poll_at"`);
  }
}
