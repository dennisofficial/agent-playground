import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddThreadStartSha1783365646056 implements MigrationInterface {
  name = 'AddThreadStartSha1783365646056';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "threads" ADD "start_sha" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "start_sha"`);
  }
}
