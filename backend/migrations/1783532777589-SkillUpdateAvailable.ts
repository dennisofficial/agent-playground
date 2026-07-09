import { MigrationInterface, QueryRunner } from "typeorm";

export class SkillUpdateAvailable1783532777589 implements MigrationInterface {
    name = 'SkillUpdateAvailable1783532777589'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // NOTE: the generator also emitted DROPs for uq_threads_ticket_id / uq_threads_job_parent_ordinal /
        // idx_memory_embedding_hnsw — generator noise unrelated to this change (per repo convention, pruned).
        await queryRunner.query(`ALTER TABLE "workspace_skills" ADD "update_available" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "workspace_skills" DROP COLUMN "update_available"`);
    }

}
