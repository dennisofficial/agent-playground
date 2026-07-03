import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSingleRunningBrainTurnGuard1783110081117 implements MigrationInterface {
    name = 'AddSingleRunningBrainTurnGuard1783110081117'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE UNIQUE INDEX "ux_active_turns_one_running_brain_per_job" ON "active_turns" ("job_id") WHERE "kind" = 'brain' AND "status" = 'running'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."ux_active_turns_one_running_brain_per_job"`);
    }

}
