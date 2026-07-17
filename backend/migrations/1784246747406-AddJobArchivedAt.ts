import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddJobArchivedAt1784246747406 implements MigrationInterface {
  name = 'AddJobArchivedAt1784246747406';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD "archived_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "archived_at"`);
  }
}
