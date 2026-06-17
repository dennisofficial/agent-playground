import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPipelineSectionDriver1781673029008 implements MigrationInterface {
    name = 'AddPipelineSectionDriver1781673029008'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "pipeline_run_sections" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "run_id" uuid NOT NULL, "team_id" text NOT NULL, "ordinal" integer NOT NULL, "name" text NOT NULL, "brief" text, "phase_role" text NOT NULL, "status" text NOT NULL DEFAULT 'pending', "plan_md" text, "phases_json" jsonb, "phase_count" integer, CONSTRAINT "uq_pipeline_run_sections_run_id_ordinal" UNIQUE ("run_id", "ordinal"), CONSTRAINT "pk_pipeline_run_sections" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_pipeline_run_sections_run_id" ON "pipeline_run_sections" ("run_id") `);
        await queryRunner.query(`ALTER TABLE "pipeline_runs" ADD "kind" text NOT NULL DEFAULT 'feature'`);
        await queryRunner.query(`ALTER TABLE "pipeline_runs" ADD "section_index" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "pipeline_runs" ADD "phase_index" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "pipeline_runs" ADD "planning_substep" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "pipeline_runs" DROP COLUMN "planning_substep"`);
        await queryRunner.query(`ALTER TABLE "pipeline_runs" DROP COLUMN "phase_index"`);
        await queryRunner.query(`ALTER TABLE "pipeline_runs" DROP COLUMN "section_index"`);
        await queryRunner.query(`ALTER TABLE "pipeline_runs" DROP COLUMN "kind"`);
        await queryRunner.query(`DROP INDEX "public"."idx_pipeline_run_sections_run_id"`);
        await queryRunner.query(`DROP TABLE "pipeline_run_sections"`);
    }

}
