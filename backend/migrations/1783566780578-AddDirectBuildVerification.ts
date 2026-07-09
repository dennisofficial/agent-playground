import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDirectBuildVerification1783566780578 implements MigrationInterface {
  name = 'AddDirectBuildVerification1783566780578';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD "direct_build_verification" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "jobs" DROP COLUMN "direct_build_verification"`,
    );
  }
}
