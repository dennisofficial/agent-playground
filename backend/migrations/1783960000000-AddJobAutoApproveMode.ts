import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Replace the per-job boolean `jobs.auto_approve` with a per-job union mode
 * `jobs.auto_approve_mode` ('off' | 'plan' | 'ship' | 'both'), stored as text per the
 * repo's text-column-union convention (no Postgres enum). Existing `true` rows backfill
 * to 'both' before the boolean column is dropped. `auto_approve_by` and its FK are unchanged.
 */
export class AddJobAutoApproveMode1783960000000 implements MigrationInterface {
    name = 'AddJobAutoApproveMode1783960000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" ADD "auto_approve_mode" text NOT NULL DEFAULT 'off'`);
        await queryRunner.query(`UPDATE "jobs" SET "auto_approve_mode" = 'both' WHERE "auto_approve" = true`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "auto_approve"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Lossy: plan/ship/both all collapse to the single `auto_approve` boolean.
        await queryRunner.query(`ALTER TABLE "jobs" ADD "auto_approve" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`UPDATE "jobs" SET "auto_approve" = true WHERE "auto_approve_mode" IN ('plan','ship','both')`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "auto_approve_mode"`);
    }

}
