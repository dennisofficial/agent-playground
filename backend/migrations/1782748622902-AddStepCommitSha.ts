import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddStepCommitSha1782748622902 implements MigrationInterface {
  name = 'AddStepCommitSha1782748622902';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "steps" ADD "commit_sha" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "steps" DROP COLUMN "commit_sha"`);
  }
}
