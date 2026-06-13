import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPlansNotesAndTeamSettings1781292618284 implements MigrationInterface {
    name = 'AddPlansNotesAndTeamSettings1781292618284'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "team_settings" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "team_id" text NOT NULL, "standup_open" boolean NOT NULL DEFAULT false, CONSTRAINT "pk_team_settings" PRIMARY KEY ("team_id"))`);
        await queryRunner.query(`CREATE TABLE "team_task_notes" ("id" SERIAL NOT NULL, "team_id" text NOT NULL, "task_id" integer NOT NULL, "author" text NOT NULL, "body" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "pk_team_task_notes" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_team_task_notes_team_id_task_id_created_at" ON "team_task_notes" ("team_id", "task_id", "created_at") `);
        await queryRunner.query(`CREATE TABLE "team_task_plans" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" SERIAL NOT NULL, "team_id" text NOT NULL, "task_id" integer NOT NULL, "employee" text NOT NULL, "plan_md" text NOT NULL, "lead_status" text NOT NULL DEFAULT 'pending', "session_id" text, CONSTRAINT "pk_team_task_plans" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_team_task_plans_team_id_task_id_employee" ON "team_task_plans" ("team_id", "task_id", "employee") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_team_task_plans_team_id_task_id_employee"`);
        await queryRunner.query(`DROP TABLE "team_task_plans"`);
        await queryRunner.query(`DROP INDEX "public"."idx_team_task_notes_team_id_task_id_created_at"`);
        await queryRunner.query(`DROP TABLE "team_task_notes"`);
        await queryRunner.query(`DROP TABLE "team_settings"`);
    }

}
