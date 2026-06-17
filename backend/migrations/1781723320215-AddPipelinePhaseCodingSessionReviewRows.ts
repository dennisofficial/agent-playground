import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPipelinePhaseCodingSessionReviewRows1781723320215 implements MigrationInterface {
    name = 'AddPipelinePhaseCodingSessionReviewRows1781723320215'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "pipeline_run_phases" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "section_id" uuid NOT NULL, "run_id" uuid NOT NULL, "team_id" text NOT NULL, "ordinal" integer NOT NULL, "plan_phase_id" integer NOT NULL, "title" text, "status" text NOT NULL DEFAULT 'pending', "coding_session_id" uuid, CONSTRAINT "uq_pipeline_run_phases_section_id_ordinal" UNIQUE ("section_id", "ordinal"), CONSTRAINT "pk_pipeline_run_phases" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_pipeline_run_phases_section_id" ON "pipeline_run_phases" ("section_id") `);
        await queryRunner.query(`CREATE INDEX "idx_pipeline_run_phases_run_id" ON "pipeline_run_phases" ("run_id") `);
        await queryRunner.query(`CREATE TABLE "pipeline_coding_sessions" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "section_id" uuid NOT NULL, "run_id" uuid NOT NULL, "team_id" text NOT NULL, "ordinal" integer NOT NULL, "status" text NOT NULL DEFAULT 'pending', "engine_session_id" text, "handoff_in" text, "handoff_out" text, CONSTRAINT "uq_pipeline_coding_sessions_section_id_ordinal" UNIQUE ("section_id", "ordinal"), CONSTRAINT "pk_pipeline_coding_sessions" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_pipeline_coding_sessions_section_id" ON "pipeline_coding_sessions" ("section_id") `);
        await queryRunner.query(`CREATE INDEX "idx_pipeline_coding_sessions_run_id" ON "pipeline_coding_sessions" ("run_id") `);
        await queryRunner.query(`CREATE TABLE "pipeline_phase_reviews" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "phase_id" uuid NOT NULL, "run_id" uuid NOT NULL, "team_id" text NOT NULL, "attempt" integer NOT NULL DEFAULT '1', "status" text NOT NULL DEFAULT 'running', "engine_session_id" text, "blocker" boolean, "summary" text, CONSTRAINT "pk_pipeline_phase_reviews" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_pipeline_phase_reviews_phase_id" ON "pipeline_phase_reviews" ("phase_id") `);
        await queryRunner.query(`CREATE INDEX "idx_pipeline_phase_reviews_run_id" ON "pipeline_phase_reviews" ("run_id") `);
        await queryRunner.query(`ALTER TABLE "pipeline_runs" ADD "active_section_id" uuid`);
        await queryRunner.query(`ALTER TABLE "pipeline_run_sections" ADD "depends_on" integer array NOT NULL DEFAULT '{}'`);
        await queryRunner.query(`ALTER TABLE "pipeline_run_sections" ADD "frozen" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "pipeline_run_sections" ADD "active_session_id" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "pipeline_run_sections" DROP COLUMN "active_session_id"`);
        await queryRunner.query(`ALTER TABLE "pipeline_run_sections" DROP COLUMN "frozen"`);
        await queryRunner.query(`ALTER TABLE "pipeline_run_sections" DROP COLUMN "depends_on"`);
        await queryRunner.query(`ALTER TABLE "pipeline_runs" DROP COLUMN "active_section_id"`);
        await queryRunner.query(`DROP INDEX "public"."idx_pipeline_phase_reviews_run_id"`);
        await queryRunner.query(`DROP INDEX "public"."idx_pipeline_phase_reviews_phase_id"`);
        await queryRunner.query(`DROP TABLE "pipeline_phase_reviews"`);
        await queryRunner.query(`DROP INDEX "public"."idx_pipeline_coding_sessions_run_id"`);
        await queryRunner.query(`DROP INDEX "public"."idx_pipeline_coding_sessions_section_id"`);
        await queryRunner.query(`DROP TABLE "pipeline_coding_sessions"`);
        await queryRunner.query(`DROP INDEX "public"."idx_pipeline_run_phases_run_id"`);
        await queryRunner.query(`DROP INDEX "public"."idx_pipeline_run_phases_section_id"`);
        await queryRunner.query(`DROP TABLE "pipeline_run_phases"`);
    }

}
