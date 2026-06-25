import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the file-backed section SPEC column: the full rubric markdown the brain authors in `/context`,
 * snapshotted into Postgres at submit_plan time (the JIT phase planner consumes it; null → fall back to
 * the one-line `brief`).
 *
 * The generator's HNSW drop/recreate + decision_records default re-statement were pruned (generator
 * noise — it cannot represent the pgvector HNSW index, and the default change is a no-op cast diff).
 */
export class AddSectionSpec1782418453538 implements MigrationInterface {
    name = 'AddSectionSpec1782418453538'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "sections" ADD "spec" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "sections" DROP COLUMN "spec"`);
    }

}
