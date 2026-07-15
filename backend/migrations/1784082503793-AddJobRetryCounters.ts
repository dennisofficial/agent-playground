import { MigrationInterface, QueryRunner } from "typeorm";

export class AddJobRetryCounters1784082503793 implements MigrationInterface {
    name = 'AddJobRetryCounters1784082503793'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" ADD "benign_abort_redrives" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD "transient_retry_redrives" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD "auth_retry_attempts" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD "driver_transient_retries" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD "retry_last_attempt_at" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "retry_last_attempt_at"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "driver_transient_retries"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "auth_retry_attempts"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "transient_retry_redrives"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "benign_abort_redrives"`);
    }

}
