import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPendingCompactionSeed1783115465602 implements MigrationInterface {
    name = 'AddPendingCompactionSeed1783115465602'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "job_sandboxes" ADD "pending_compaction_seed" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "job_sandboxes" DROP COLUMN "pending_compaction_seed"`);
    }

}
