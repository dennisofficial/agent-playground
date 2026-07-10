import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBuildPath1783600900000 implements MigrationInterface {
  name = 'AddBuildPath1783600900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" ADD "build_path" text`);
    // Backfill already-finished DIRECT builds: a non-null direct_build_verification is the durable proof a
    // job reached finalize_build via the direct path. Plan builds are left null (they carry build threads,
    // so the UI never shows the plan-oriented placeholders for them anyway).
    await queryRunner.query(
      `UPDATE "jobs" SET "build_path" = 'direct' WHERE "direct_build_verification" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "build_path"`);
  }
}
