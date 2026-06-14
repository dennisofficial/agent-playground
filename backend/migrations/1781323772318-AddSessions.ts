import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSessions1781323772318 implements MigrationInterface {
    name = 'AddSessions1781323772318'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "sessions" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" text NOT NULL, "task" text NOT NULL, "worktree_id" text NOT NULL, "status" text NOT NULL, "notify_thread" text NOT NULL, "owner_bot" text NOT NULL, "team" text NOT NULL, "project" text NOT NULL, "engine" text NOT NULL, "mode" text NOT NULL, "engine_session_id" text, "turns" integer NOT NULL DEFAULT '0', "last_report" text, "last_report_kind" text, "qa" jsonb, "board_task_id" integer, "plan_attached" boolean, "error" text, CONSTRAINT "pk_sessions" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_sessions_worktree_id" ON "sessions" ("worktree_id") `);
        await queryRunner.query(`CREATE INDEX "idx_sessions_status" ON "sessions" ("status") `);
        await queryRunner.query(`CREATE INDEX "idx_sessions_owner_bot" ON "sessions" ("owner_bot") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_sessions_owner_bot"`);
        await queryRunner.query(`DROP INDEX "public"."idx_sessions_status"`);
        await queryRunner.query(`DROP INDEX "public"."idx_sessions_worktree_id"`);
        await queryRunner.query(`DROP TABLE "sessions"`);
    }

}
