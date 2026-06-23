import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Per-thread sandbox = durable worktree/branch/session + DISPOSABLE container. Adds the columns that
 * drive the idle reaper (`last_active_at`) and the PR-merge cleanup poll (`pr_url`, `pr_number`).
 *
 * (Generator noise pruned: it tried to drop/recreate unrelated FK constraints, the pgvector HNSW index,
 * and a partial index, plus cosmetic DEFAULT normalizations — none of which this change touches.)
 */
export class ThreadSandboxDurableLifecycle1782253930611 implements MigrationInterface {
    name = 'ThreadSandboxDurableLifecycle1782253930611'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "atlas_thread_sandboxes" ADD "last_active_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "atlas_thread_sandboxes" ADD "pr_url" text`);
        await queryRunner.query(`ALTER TABLE "atlas_thread_sandboxes" ADD "pr_number" integer`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "atlas_thread_sandboxes" DROP COLUMN "pr_number"`);
        await queryRunner.query(`ALTER TABLE "atlas_thread_sandboxes" DROP COLUMN "pr_url"`);
        await queryRunner.query(`ALTER TABLE "atlas_thread_sandboxes" DROP COLUMN "last_active_at"`);
    }

}
