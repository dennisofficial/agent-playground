import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSessionLimitTextMisfires1784131997433 implements MigrationInterface {
    name = 'AddSessionLimitTextMisfires1784131997433'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" ADD "session_limit_text_misfires_main" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD "session_limit_text_misfires_build" integer NOT NULL DEFAULT '0'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "session_limit_text_misfires_build"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "session_limit_text_misfires_main"`);
    }

}
