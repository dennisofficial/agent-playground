import { MigrationInterface, QueryRunner } from "typeorm";

export class ThreadsRedesign1784222156471 implements MigrationInterface {
    name = 'ThreadsRedesign1784222156471'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // --- adds (new columns needed as targets for the remaps below) ---
        await queryRunner.query(`ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "focused_thread_id" uuid`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "build_path" text`);
        await queryRunner.query(`ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "halt_reason" text`);

        // --- remaps (data UPDATEs before any DROP/retighten) ---

        // jobs.build_path: direct_build thread groups mark their job as 'direct'; everything else defaults 'plan'.
        await queryRunner.query(`UPDATE "jobs" SET "build_path" = 'direct' WHERE "id" IN (SELECT "job_id" FROM "thread_groups" WHERE "kind" = 'direct_build')`);
        await queryRunner.query(`UPDATE "jobs" SET "build_path" = 'plan' WHERE "build_path" IS NULL`);

        // thread_groups.kind: build/direct_build -> section, ci -> ship.
        await queryRunner.query(`UPDATE "thread_groups" SET "kind" = 'section' WHERE "kind" IN ('build', 'direct_build')`);
        await queryRunner.query(`UPDATE "thread_groups" SET "kind" = 'ship' WHERE "kind" = 'ci'`);

        // plan_review thread groups fold into their job's planning group (codex thread now lives there);
        // reparent their threads onto the sibling planning group, then drop the now-empty plan_review groups.
        // Best-effort (decision d8): a plan_review group without a planning sibling is abandoned — its
        // threads cascade-delete with it, which is acceptable for in-flight rows.
        await queryRunner.query(`
            UPDATE "threads" t
            SET "thread_group_id" = pg."id"
            FROM "thread_groups" pr
            JOIN "thread_groups" pg ON pg."job_id" = pr."job_id" AND pg."kind" = 'planning'
            WHERE t."thread_group_id" = pr."id" AND pr."kind" = 'plan_review'
        `);
        await queryRunner.query(`DELETE FROM "thread_groups" WHERE "kind" = 'plan_review'`);

        // thread_groups.status: pending|planning|reviewing|executing|auto_fixing|done -> pending|active|done.
        await queryRunner.query(`UPDATE "thread_groups" SET "status" = 'active' WHERE "status" IN ('planning', 'reviewing', 'executing', 'auto_fixing')`);

        // threads.role: planning -> planner, plan_review -> codex_review, ci -> ship.
        await queryRunner.query(`UPDATE "threads" SET "role" = 'planner' WHERE "role" = 'planning'`);
        await queryRunner.query(`UPDATE "threads" SET "role" = 'codex_review' WHERE "role" = 'plan_review'`);
        await queryRunner.query(`UPDATE "threads" SET "role" = 'ship' WHERE "role" = 'ci'`);

        // threads.status: pending|planning|reviewing|executing|auto_fixing|done -> idle|done.
        await queryRunner.query(`UPDATE "threads" SET "status" = 'idle' WHERE "status" != 'done'`);

        // jobs.status: best-effort remap to the new activity-level enum; blocked/amending/cancelled/deleting unchanged.
        await queryRunner.query(`UPDATE "jobs" SET "status" = 'scoping' WHERE "status" = 'open'`);
        await queryRunner.query(`UPDATE "jobs" SET "status" = 'plan_reviewing' WHERE "status" = 'plan_review'`);
        await queryRunner.query(`UPDATE "jobs" SET "status" = 'building' WHERE "status" = 'running'`);
        await queryRunner.query(`UPDATE "jobs" SET "status" = 'ready' WHERE "status" = 'awaiting_ship_review'`);
        await queryRunner.query(`UPDATE "jobs" SET "status" = 'merged' WHERE "status" = 'done'`);

        // --- retighten adds now that data is populated ---
        await queryRunner.query(`ALTER TABLE "jobs" ALTER COLUMN "build_path" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "jobs" ALTER COLUMN "build_path" SET DEFAULT 'plan'`);
        await queryRunner.query(`ALTER TABLE "jobs" ALTER COLUMN "status" SET DEFAULT 'scoping'`);
        await queryRunner.query(`ALTER TABLE "threads" ALTER COLUMN "status" SET DEFAULT 'idle'`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD CONSTRAINT "fk_jobs_focused_thread_id_threads" FOREIGN KEY ("focused_thread_id") REFERENCES "threads"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);

        // --- drops (gating/halt/relay machinery, gone) ---
        await queryRunner.query(`ALTER TABLE "thread_groups" DROP COLUMN IF EXISTS "condition"`);
        await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN IF EXISTS "condition"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN IF EXISTS "pipeline_awareness"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN IF EXISTS "halted"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN IF EXISTS "halt"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN IF EXISTS "direct_build_verification"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN IF EXISTS "session_resume"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN IF EXISTS "activity"`);
        await queryRunner.query(`ALTER TABLE "job_sandboxes" DROP COLUMN IF EXISTS "pending_compaction_seed"`);
        await queryRunner.query(`ALTER TABLE "job_sandboxes" DROP COLUMN IF EXISTS "compacting_session_id"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "job_sandboxes" ADD COLUMN IF NOT EXISTS "compacting_session_id" text`);
        await queryRunner.query(`ALTER TABLE "job_sandboxes" ADD COLUMN IF NOT EXISTS "pending_compaction_seed" text`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "activity" text NOT NULL DEFAULT 'idle'`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "session_resume" jsonb`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "direct_build_verification" jsonb`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "halt" jsonb`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "halted" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "pipeline_awareness" jsonb NOT NULL DEFAULT '{"markerQueue": [], "conveyedStateSig": null}'`);
        await queryRunner.query(`ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "condition" text NOT NULL DEFAULT 'none'`);
        await queryRunner.query(`ALTER TABLE "thread_groups" ADD COLUMN IF NOT EXISTS "condition" text NOT NULL DEFAULT 'none'`);

        await queryRunner.query(`ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "fk_jobs_focused_thread_id_threads"`);
        await queryRunner.query(`ALTER TABLE "threads" ALTER COLUMN "status" SET DEFAULT 'pending'`);
        await queryRunner.query(`ALTER TABLE "jobs" ALTER COLUMN "status" SET DEFAULT 'open'`);
        await queryRunner.query(`ALTER TABLE "jobs" ALTER COLUMN "build_path" DROP DEFAULT`);
        await queryRunner.query(`ALTER TABLE "jobs" ALTER COLUMN "build_path" DROP NOT NULL`);

        // best-effort reverse remaps (lossy: plan_review/direct_build/build distinctions were dropped)
        await queryRunner.query(`UPDATE "jobs" SET "status" = 'done' WHERE "status" = 'merged'`);
        await queryRunner.query(`UPDATE "jobs" SET "status" = 'awaiting_ship_review' WHERE "status" = 'ready'`);
        await queryRunner.query(`UPDATE "jobs" SET "status" = 'running' WHERE "status" = 'building'`);
        await queryRunner.query(`UPDATE "jobs" SET "status" = 'plan_review' WHERE "status" = 'plan_reviewing'`);
        await queryRunner.query(`UPDATE "jobs" SET "status" = 'open' WHERE "status" = 'scoping'`);
        await queryRunner.query(`UPDATE "threads" SET "status" = 'pending' WHERE "status" = 'idle'`);
        await queryRunner.query(`UPDATE "threads" SET "role" = 'ci' WHERE "role" = 'ship'`);
        await queryRunner.query(`UPDATE "threads" SET "role" = 'plan_review' WHERE "role" = 'codex_review'`);
        await queryRunner.query(`UPDATE "threads" SET "role" = 'planning' WHERE "role" = 'planner'`);
        await queryRunner.query(`UPDATE "thread_groups" SET "status" = 'executing' WHERE "status" = 'active'`);
        await queryRunner.query(`UPDATE "thread_groups" SET "kind" = 'ci' WHERE "kind" = 'ship'`);
        await queryRunner.query(`UPDATE "thread_groups" SET "kind" = 'build' WHERE "kind" = 'section'`);

        await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN IF EXISTS "halt_reason"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN IF EXISTS "build_path"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN IF EXISTS "focused_thread_id"`);
    }

}
