import { MigrationInterface, QueryRunner } from "typeorm";

export class CreatePipelineRuns1781643374689 implements MigrationInterface {
    name = 'CreatePipelineRuns1781643374689'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "pipeline_runs" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "team_id" text NOT NULL, "task_id" integer NOT NULL, "pipeline" text NOT NULL, "stage_index" integer NOT NULL DEFAULT '0', "status" text NOT NULL DEFAULT 'running', "current_role" text, "mode" text, "worktree_id" text, "session_id" text, CONSTRAINT "pk_pipeline_runs" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_pipeline_runs_team_id_status" ON "pipeline_runs" ("team_id", "status") `);
        await queryRunner.query(`CREATE INDEX "idx_pipeline_runs_team_id_task_id" ON "pipeline_runs" ("team_id", "task_id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_pipeline_runs_team_id_task_id"`);
        await queryRunner.query(`DROP INDEX "public"."idx_pipeline_runs_team_id_status"`);
        await queryRunner.query(`DROP TABLE "pipeline_runs"`);
    }

}
