import { MigrationInterface, QueryRunner } from "typeorm";

export class AtlasGitOwnershipFields1783037420431 implements MigrationInterface {
    name = 'AtlasGitOwnershipFields1783037420431'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "repos" ADD "branch_prefix" text`);
        await queryRunner.query(`ALTER TABLE "repos" ADD "branch_regex" text`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD "current_branch" text`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD "ci_status" text`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD "pr_mergeable" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "pr_mergeable"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "ci_status"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "current_branch"`);
        await queryRunner.query(`ALTER TABLE "repos" DROP COLUMN "branch_regex"`);
        await queryRunner.query(`ALTER TABLE "repos" DROP COLUMN "branch_prefix"`);
    }

}
