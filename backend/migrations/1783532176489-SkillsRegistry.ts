import { MigrationInterface, QueryRunner } from "typeorm";

export class SkillsRegistry1783532176489 implements MigrationInterface {
    name = 'SkillsRegistry1783532176489'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // NOTE: the generator also emitted DROPs for uq_threads_ticket_id / uq_threads_job_parent_ordinal /
        // idx_memory_embedding_hnsw — generator noise unrelated to this change (per repo convention, pruned).
        await queryRunner.query(`ALTER TABLE "workspace_skills" DROP COLUMN "body"`);
        await queryRunner.query(`ALTER TABLE "workspace_skills" ADD "provenance" text NOT NULL DEFAULT 'custom'`);
        await queryRunner.query(`ALTER TABLE "workspace_skills" ADD "source_url" text`);
        await queryRunner.query(`ALTER TABLE "workspace_skills" ADD "source_ref" text`);
        await queryRunner.query(`ALTER TABLE "workspace_skills" ADD "source_subpath" text`);
        await queryRunner.query(`ALTER TABLE "workspace_skills" ADD "installed_sha" text`);
        await queryRunner.query(`ALTER TABLE "workspace_skills" ADD "update_policy" text`);
        await queryRunner.query(`ALTER TABLE "workspace_skills" ADD "forked_from" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "workspace_skills" DROP COLUMN "forked_from"`);
        await queryRunner.query(`ALTER TABLE "workspace_skills" DROP COLUMN "update_policy"`);
        await queryRunner.query(`ALTER TABLE "workspace_skills" DROP COLUMN "installed_sha"`);
        await queryRunner.query(`ALTER TABLE "workspace_skills" DROP COLUMN "source_subpath"`);
        await queryRunner.query(`ALTER TABLE "workspace_skills" DROP COLUMN "source_ref"`);
        await queryRunner.query(`ALTER TABLE "workspace_skills" DROP COLUMN "source_url"`);
        await queryRunner.query(`ALTER TABLE "workspace_skills" DROP COLUMN "provenance"`);
        await queryRunner.query(`ALTER TABLE "workspace_skills" ADD "body" text NOT NULL`);
    }

}
