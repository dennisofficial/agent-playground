import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEngineProvenanceColumns1784066059233 implements MigrationInterface {
  name = 'AddEngineProvenanceColumns1784066059233';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "messages" ADD "engine_git_sha" text`);
    await queryRunner.query(
      `ALTER TABLE "turn_stats" ADD "credential_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "turn_stats" ADD "engine_git_sha" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "turn_stats" DROP COLUMN "engine_git_sha"`,
    );
    await queryRunner.query(
      `ALTER TABLE "turn_stats" DROP COLUMN "credential_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" DROP COLUMN "engine_git_sha"`,
    );
  }
}
