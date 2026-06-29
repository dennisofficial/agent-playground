import { MigrationInterface, QueryRunner } from "typeorm";

export class UpdateDefaults1782766146137 implements MigrationInterface {
    name = 'UpdateDefaults1782766146137'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "decision_records" ALTER COLUMN "decisions" SET DEFAULT '[]'::jsonb`);
        await queryRunner.query(`ALTER TABLE "threads" ALTER COLUMN "pipeline_awareness" SET DEFAULT '{"markerQueue":[],"conveyedStateSig":null}'::jsonb`);
        await queryRunner.query(`ALTER TABLE "threads" ALTER COLUMN "pending_decisions" SET DEFAULT '[]'::jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "threads" ALTER COLUMN "pending_decisions" SET DEFAULT '[]'`);
        await queryRunner.query(`ALTER TABLE "threads" ALTER COLUMN "pipeline_awareness" SET DEFAULT '{"markerQueue": [], "conveyedStateSig": null}'`);
        await queryRunner.query(`ALTER TABLE "decision_records" ALTER COLUMN "decisions" SET DEFAULT '[]'`);
    }

}
