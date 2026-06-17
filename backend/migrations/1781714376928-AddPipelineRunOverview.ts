import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPipelineRunOverview1781714376928 implements MigrationInterface {
    name = 'AddPipelineRunOverview1781714376928'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "pipeline_runs" ADD "overview" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "pipeline_runs" DROP COLUMN "overview"`);
    }

}
