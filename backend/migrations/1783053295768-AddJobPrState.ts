import { MigrationInterface, QueryRunner } from "typeorm";

export class AddJobPrState1783053295768 implements MigrationInterface {
    name = 'AddJobPrState1783053295768'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" ADD "pr_state" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "pr_state"`);
    }

}
