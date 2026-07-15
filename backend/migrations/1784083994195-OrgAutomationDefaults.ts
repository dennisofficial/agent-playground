import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Add two org-level automation defaults (`default_auto_approve_mode`, `default_auto_merge`) that a new
 * job inherits at creation when the create-job request omits an explicit value (mirrors the repo-level
 * auto-merge defaults added in `RepoAutoMergeDefaults1784030000000`, one tier up at the org). Additive
 * only — safe defaults, no transform, no drops.
 */
export class OrgAutomationDefaults1784040000000 implements MigrationInterface {
    name = 'OrgAutomationDefaults1784040000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "organizations" ADD "default_auto_approve_mode" text NOT NULL DEFAULT 'off'`);
        await queryRunner.query(`ALTER TABLE "organizations" ADD "default_auto_merge" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN "default_auto_merge"`);
        await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN "default_auto_approve_mode"`);
    }

}
