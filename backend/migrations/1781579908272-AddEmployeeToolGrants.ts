import { MigrationInterface, QueryRunner } from "typeorm";

export class AddEmployeeToolGrants1781579908272 implements MigrationInterface {
    name = 'AddEmployeeToolGrants1781579908272'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // `employee_skills` already exists on the dev DB (created out-of-band, never via a migration),
        // so the generator didn't emit it — but a FRESH DB (incl. the agent_playground_test DB the int
        // tests build from migrations) needs it. IF NOT EXISTS makes this safe on the drifted dev DB
        // and correct everywhere else.
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "employee_skills" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" SERIAL NOT NULL, "employee_id" text NOT NULL, "team_id" text, "name" text NOT NULL, "description" text NOT NULL DEFAULT '', "source" jsonb NOT NULL, CONSTRAINT "pk_employee_skills" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_employee_skills_employee_id_team_id" ON "employee_skills" ("employee_id", "team_id") `);

        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "employee_mcp_servers" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" SERIAL NOT NULL, "employee_id" text NOT NULL, "team_id" text, "name" text NOT NULL, "config" jsonb NOT NULL, CONSTRAINT "pk_employee_mcp_servers" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_employee_mcp_servers_employee_id_team_id" ON "employee_mcp_servers" ("employee_id", "team_id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."idx_employee_mcp_servers_employee_id_team_id"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "employee_mcp_servers"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."idx_employee_skills_employee_id_team_id"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "employee_skills"`);
    }

}
