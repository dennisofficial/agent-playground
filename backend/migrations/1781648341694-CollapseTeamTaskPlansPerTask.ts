import { MigrationInterface, QueryRunner } from "typeorm";

export class CollapseTeamTaskPlansPerTask1781648341694 implements MigrationInterface {
    name = 'CollapseTeamTaskPlansPerTask1781648341694'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_team_task_plans_team_id_task_id_employee"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_team_task_plans_team_id_task_id" ON "team_task_plans" ("team_id", "task_id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_team_task_plans_team_id_task_id"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_team_task_plans_team_id_task_id_employee" ON "team_task_plans" ("team_id", "task_id", "employee") `);
    }

}
