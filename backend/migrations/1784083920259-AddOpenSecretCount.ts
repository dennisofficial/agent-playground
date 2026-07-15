import { MigrationInterface, QueryRunner } from "typeorm";

export class AddOpenSecretCount1783991528908 implements MigrationInterface {
    name = 'AddOpenSecretCount1783991528908'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" ADD "open_secret_count" integer NOT NULL DEFAULT '0'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "open_secret_count"`);
    }

}
