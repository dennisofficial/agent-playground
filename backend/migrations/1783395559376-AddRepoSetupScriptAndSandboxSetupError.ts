import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRepoSetupScriptAndSandboxSetupError1783395559376 implements MigrationInterface {
  name = 'AddRepoSetupScriptAndSandboxSetupError1783395559376';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "repos" ADD "setup_script" text`);
    await queryRunner.query(`ALTER TABLE "job_sandboxes" ADD "setup_error" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "job_sandboxes" DROP COLUMN "setup_error"`);
    await queryRunner.query(`ALTER TABLE "repos" DROP COLUMN "setup_script"`);
  }
}
