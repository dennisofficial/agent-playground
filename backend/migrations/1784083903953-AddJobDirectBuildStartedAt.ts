import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add `jobs.direct_build_started_at` — the durable "the DIRECT build has started" marker, stamped when
 * `dispatch_build` fires `runDirectBuild`. Closes the pre-start base-check window for the direct path in
 * `BrainStoreService.buildNotStarted` at the START of the implement turn (unlike `direct_build_verification`,
 * written only at the `finalize_build` gate at the END), so `hold_build` can no longer reopen planning
 * underneath a live implementation turn. Null for jobs that never ran a direct build.
 */
export class AddJobDirectBuildStartedAt1783950000000 implements MigrationInterface {
  name = 'AddJobDirectBuildStartedAt1783950000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD "direct_build_started_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "jobs" DROP COLUMN "direct_build_started_at"`,
    );
  }
}
