import { MigrationInterface, QueryRunner } from "typeorm";

export class StripHaltMachinery1784150306913 implements MigrationInterface {
    name = 'StripHaltMachinery1784150306913'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "halt_fix_attempts"`);
        await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "halt_outcome"`);
        await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "done_wake_gen"`);
        await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "halt_waked_at"`);
        await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "done_waked_at"`);
        await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "done_wake_owed"`);
        await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "done_wake_reason"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "threads" ADD "done_wake_reason" text`);
        await queryRunner.query(`ALTER TABLE "threads" ADD "done_wake_owed" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "threads" ADD "done_waked_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "threads" ADD "halt_waked_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "threads" ADD "done_wake_gen" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "threads" ADD "halt_outcome" text`);
        await queryRunner.query(`ALTER TABLE "threads" ADD "halt_fix_attempts" integer NOT NULL DEFAULT '0'`);
    }

}
