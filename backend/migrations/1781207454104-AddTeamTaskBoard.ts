import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTeamTaskBoard1781207454104 implements MigrationInterface {
    name = 'AddTeamTaskBoard1781207454104'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "team_tasks" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" SERIAL NOT NULL, "team_id" text NOT NULL, "project" text NOT NULL, "title" text NOT NULL, "description" text NOT NULL DEFAULT '', "status" text NOT NULL DEFAULT 'open', "assignee" text, "created_by" text NOT NULL, "depends_on" integer array NOT NULL DEFAULT '{}', CONSTRAINT "pk_team_tasks" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_team_tasks_team_id_assignee_status" ON "team_tasks" ("team_id", "assignee", "status") `);
        await queryRunner.query(`CREATE INDEX "idx_team_tasks_team_id_project_status" ON "team_tasks" ("team_id", "project", "status") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_team_tasks_team_id_project_status"`);
        await queryRunner.query(`DROP INDEX "public"."idx_team_tasks_team_id_assignee_status"`);
        await queryRunner.query(`DROP TABLE "team_tasks"`);
    }

}
