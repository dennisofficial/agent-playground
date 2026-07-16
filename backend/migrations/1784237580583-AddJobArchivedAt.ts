import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddJobArchivedAt1784237580583 implements MigrationInterface {
  name = 'AddJobArchivedAt1784237580583';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD "archived_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "archived_at"`);
  }
}
