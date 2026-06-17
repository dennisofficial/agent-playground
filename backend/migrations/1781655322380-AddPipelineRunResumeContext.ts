import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPipelineRunResumeContext1781655322380 implements MigrationInterface {
    name = 'AddPipelineRunResumeContext1781655322380'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Durable resume coordinates for a pipeline run — so a paused/in-flight run recovers without a
        // live stage session (onBoardEvent + resumePipelines read these off the row).
        await queryRunner.query(`ALTER TABLE "pipeline_runs" ADD "notify_thread" text`);
        await queryRunner.query(`ALTER TABLE "pipeline_runs" ADD "project" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "pipeline_runs" DROP COLUMN "project"`);
        await queryRunner.query(`ALTER TABLE "pipeline_runs" DROP COLUMN "notify_thread"`);
    }

}
