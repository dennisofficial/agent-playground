import { MigrationInterface, QueryRunner } from "typeorm";

export class AddJobCiCounts1783800000000 implements MigrationInterface {
    name = 'AddJobCiCounts1783800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" ADD "ci_counts" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "ci_counts"`);
    }

}
