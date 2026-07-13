import { MigrationInterface, QueryRunner } from "typeorm";

export class AddJobPortState1784010000000 implements MigrationInterface {
    name = 'AddJobPortState1784010000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" ADD "port_state" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "port_state"`);
    }

}
