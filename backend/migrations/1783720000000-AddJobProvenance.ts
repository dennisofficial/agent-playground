import { MigrationInterface, QueryRunner } from "typeorm";

export class AddJobProvenance1783720000000 implements MigrationInterface {
    name = 'AddJobProvenance1783720000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" ADD "created_by_job_id" uuid`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD "created_by" jsonb`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD CONSTRAINT "fk_jobs_created_by_job_id_jobs" FOREIGN KEY ("created_by_job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" DROP CONSTRAINT "fk_jobs_created_by_job_id_jobs"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "created_by"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "created_by_job_id"`);
    }

}
