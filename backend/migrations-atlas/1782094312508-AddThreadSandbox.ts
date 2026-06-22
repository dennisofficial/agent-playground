import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * R2 — Add per-thread sandbox association + base_branch on threads.
 *
 * Net-new:
 *  - `atlas_thread_sandboxes` — the thread↔sandbox association row (container id + base/feature
 *    branch + lifecycle); one row per thread that has been explicitly provisioned via the new
 *    create-thread control path.
 *  - `atlas_threads.base_branch` — the branch the operator picked at thread creation (null for
 *    inbound-message-derived threads that pre-date R2).
 *
 * Pruned generator noise (left alone):
 *  - FK drops/re-adds (the generator always diffs these against the baseline; constraints are live)
 *  - pgvector HNSW index drop/recreate (generator can't emit the correct `USING hnsw … WITH` syntax)
 *  - partial unique index on atlas_stimuli (already correct in the DB)
 */
export class AddThreadSandbox1782094312508 implements MigrationInterface {
    name = 'AddThreadSandbox1782094312508'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // New table: per-thread sandbox association
        await queryRunner.query(`
            CREATE TABLE "atlas_thread_sandboxes" (
                "created_at"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated_at"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "id"             uuid NOT NULL DEFAULT gen_random_uuid(),
                "team_id"        text NOT NULL,
                "thread_id"      uuid NOT NULL,
                "project_id"     text NOT NULL,
                "base_branch"    text NOT NULL,
                "feature_branch" text,
                "worktree_path"  text NOT NULL,
                "container_id"   text,
                "lifecycle"      text NOT NULL DEFAULT 'provisioning',
                CONSTRAINT "pk_atlas_thread_sandboxes" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "idx_atlas_thread_sandboxes_team_id_thread_id"
            ON "atlas_thread_sandboxes" ("team_id", "thread_id")
        `);

        // New column: base branch on threads (nullable — old rows stay null)
        await queryRunner.query(`ALTER TABLE "atlas_threads" ADD "base_branch" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "atlas_threads" DROP COLUMN "base_branch"`);
        await queryRunner.query(`DROP INDEX "public"."idx_atlas_thread_sandboxes_team_id_thread_id"`);
        await queryRunner.query(`DROP TABLE "atlas_thread_sandboxes"`);
    }
}
