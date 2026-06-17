import { MigrationInterface, QueryRunner } from "typeorm";

export class CollapseTeamTaskPlansPerTask1781648341694 implements MigrationInterface {
    name = 'CollapseTeamTaskPlansPerTask1781648341694'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_team_task_plans_team_id_task_id_employee"`);
        // Collapse to one plan per (team, task): the prior model allowed a row per employee, so any
        // task with multiple authored plans would make the new UNIQUE index fail to create. Keep the
        // LATEST row per (team_id, task_id) (max updated_at, id as tiebreak) — matching attach()'s
        // "latest plan wins" semantics — and delete the rest BEFORE adding the constraint.
        await queryRunner.query(`
            DELETE FROM "team_task_plans" a
            USING "team_task_plans" b
            WHERE a."team_id" = b."team_id"
              AND a."task_id" = b."task_id"
              AND (a."updated_at" < b."updated_at"
                   OR (a."updated_at" = b."updated_at" AND a."id" < b."id"))
        `);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_team_task_plans_team_id_task_id" ON "team_task_plans" ("team_id", "task_id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_team_task_plans_team_id_task_id"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_team_task_plans_team_id_task_id_employee" ON "team_task_plans" ("team_id", "task_id", "employee") `);
    }

}
