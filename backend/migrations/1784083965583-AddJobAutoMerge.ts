import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Add the four per-job AUTO-MERGE columns to `jobs`: the `auto_merge` master toggle, the configurable
 * `auto_merge_method` (merge|squash|rebase, text-union per repo convention), `auto_merge_delete_branch`,
 * and `auto_merge_by` (FK → users.id, SET NULL — who most recently enabled auto-merge). Pure additive —
 * every column has a safe default, so no data transform is needed.
 */
export class AddJobAutoMerge1784020000000 implements MigrationInterface {
    name = 'AddJobAutoMerge1784020000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" ADD "auto_merge" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD "auto_merge_method" text NOT NULL DEFAULT 'squash'`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD "auto_merge_delete_branch" boolean NOT NULL DEFAULT true`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD "auto_merge_by" uuid`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD CONSTRAINT "fk_jobs_auto_merge_by_users" FOREIGN KEY ("auto_merge_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" DROP CONSTRAINT "fk_jobs_auto_merge_by_users"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "auto_merge_by"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "auto_merge_delete_branch"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "auto_merge_method"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "auto_merge"`);
    }

}
