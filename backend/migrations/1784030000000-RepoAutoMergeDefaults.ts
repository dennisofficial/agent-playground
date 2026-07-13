import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Move the merge METHOD + DELETE-BRANCH settings from the job to the repo: add the two per-repo
 * defaults (`default_auto_merge_method`, `default_auto_merge_delete_branch`) and drop the now-redundant
 * per-job `auto_merge_method` / `auto_merge_delete_branch` columns. The repo columns are additive (safe
 * defaults, no transform); the job-column drops are destructive — the old per-job values were only ever
 * defaults, so discarding them is acceptable (the repo default takes over). `auto_merge` / `auto_merge_by`
 * stay on `jobs` (the per-job arm toggle + approver).
 */
export class RepoAutoMergeDefaults1784030000000 implements MigrationInterface {
    name = 'RepoAutoMergeDefaults1784030000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "repos" ADD "default_auto_merge_method" text NOT NULL DEFAULT 'squash'`);
        await queryRunner.query(`ALTER TABLE "repos" ADD "default_auto_merge_delete_branch" boolean NOT NULL DEFAULT true`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "auto_merge_method"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "auto_merge_delete_branch"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" ADD "auto_merge_delete_branch" boolean NOT NULL DEFAULT true`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD "auto_merge_method" text NOT NULL DEFAULT 'squash'`);
        await queryRunner.query(`ALTER TABLE "repos" DROP COLUMN "default_auto_merge_delete_branch"`);
        await queryRunner.query(`ALTER TABLE "repos" DROP COLUMN "default_auto_merge_method"`);
    }

}
