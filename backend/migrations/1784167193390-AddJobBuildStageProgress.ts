import { MigrationInterface, QueryRunner } from "typeorm";

export class AddJobBuildStageProgress1784167193390 implements MigrationInterface {
    name = 'AddJobBuildStageProgress1784167193390'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" ADD "build_stages_done" integer`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD "build_stages_total" integer`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "build_stages_total"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "build_stages_done"`);
    }

}
