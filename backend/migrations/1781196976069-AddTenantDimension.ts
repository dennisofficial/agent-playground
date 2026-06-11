import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTenantDimension1781196976069 implements MigrationInterface {
    name = 'AddTenantDimension1781196976069'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_github_tokens_is_default"`);
        await queryRunner.query(`DROP INDEX "public"."idx_tasks_project_owner_norm"`);
        await queryRunner.query(`DROP INDEX "public"."idx_tasks_project_status_owner"`);
        await queryRunner.query(`DROP INDEX "public"."idx_worklog_project_owner_bot_completed_at"`);
        await queryRunner.query(`CREATE TABLE "employee_skills" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" SERIAL NOT NULL, "employee_id" text NOT NULL, "team_id" text, "name" text NOT NULL, "description" text NOT NULL DEFAULT '', "source" jsonb NOT NULL, CONSTRAINT "pk_employee_skills" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_employee_skills_employee_id_team_id" ON "employee_skills" ("employee_id", "team_id") `);
        await queryRunner.query(`CREATE TABLE "tenants" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "team_id" text NOT NULL, "team_name" text NOT NULL, "status" text NOT NULL DEFAULT 'active', "bot_token_ciphertext" text NOT NULL, "installed_by" text, CONSTRAINT "pk_tenants" PRIMARY KEY ("team_id"))`);
        await queryRunner.query(`ALTER TABLE "channels" ADD "team_id" text NOT NULL`);
        await queryRunner.query(`ALTER TABLE "facts" ADD "team_id" text`);
        await queryRunner.query(`ALTER TABLE "github_tokens" ADD "team_id" text NOT NULL`);
        await queryRunner.query(`ALTER TABLE "github_tokens" DROP CONSTRAINT "pk_github_tokens"`);
        await queryRunner.query(`ALTER TABLE "github_tokens" ADD CONSTRAINT "pk_github_tokens" PRIMARY KEY ("name", "team_id")`);
        await queryRunner.query(`ALTER TABLE "projects" ADD "team_id" text NOT NULL`);
        await queryRunner.query(`ALTER TABLE "projects" DROP CONSTRAINT "pk_projects"`);
        await queryRunner.query(`ALTER TABLE "projects" ADD CONSTRAINT "pk_projects" PRIMARY KEY ("project_id", "team_id")`);
        await queryRunner.query(`ALTER TABLE "provider_keys" ADD "team_id" text NOT NULL`);
        await queryRunner.query(`ALTER TABLE "provider_keys" DROP CONSTRAINT "pk_provider_keys"`);
        await queryRunner.query(`ALTER TABLE "provider_keys" ADD CONSTRAINT "pk_provider_keys" PRIMARY KEY ("provider", "team_id")`);
        await queryRunner.query(`ALTER TABLE "slack_identities" ADD "team_id" text NOT NULL`);
        await queryRunner.query(`ALTER TABLE "slack_identities" DROP CONSTRAINT "pk_slack_identities"`);
        await queryRunner.query(`ALTER TABLE "slack_identities" ADD CONSTRAINT "pk_slack_identities" PRIMARY KEY ("bot_id", "team_id")`);
        await queryRunner.query(`ALTER TABLE "tasks" ADD "team_id" text NOT NULL`);
        await queryRunner.query(`ALTER TABLE "worklog" ADD "team_id" text NOT NULL`);
        await queryRunner.query(`CREATE INDEX "idx_channels_team_id" ON "channels" ("team_id") `);
        await queryRunner.query(`CREATE INDEX "idx_facts_team_id_scope" ON "facts" ("team_id", "scope") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_github_tokens_team_id" ON "github_tokens" ("team_id") WHERE is_default`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_tasks_team_id_project_owner_norm" ON "tasks" ("team_id", "project", "owner", "norm") WHERE status = 'open'`);
        await queryRunner.query(`CREATE INDEX "idx_tasks_team_id_project_status_owner" ON "tasks" ("team_id", "project", "status", "owner") `);
        await queryRunner.query(`CREATE INDEX "idx_worklog_team_id_project_owner_bot_completed_at" ON "worklog" ("team_id", "project", "owner_bot", "completed_at") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_worklog_team_id_project_owner_bot_completed_at"`);
        await queryRunner.query(`DROP INDEX "public"."idx_tasks_team_id_project_status_owner"`);
        await queryRunner.query(`DROP INDEX "public"."idx_tasks_team_id_project_owner_norm"`);
        await queryRunner.query(`DROP INDEX "public"."idx_github_tokens_team_id"`);
        await queryRunner.query(`DROP INDEX "public"."idx_facts_team_id_scope"`);
        await queryRunner.query(`DROP INDEX "public"."idx_channels_team_id"`);
        await queryRunner.query(`ALTER TABLE "worklog" DROP COLUMN "team_id"`);
        await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "team_id"`);
        await queryRunner.query(`ALTER TABLE "slack_identities" DROP CONSTRAINT "pk_slack_identities"`);
        await queryRunner.query(`ALTER TABLE "slack_identities" ADD CONSTRAINT "pk_slack_identities" PRIMARY KEY ("bot_id")`);
        await queryRunner.query(`ALTER TABLE "slack_identities" DROP COLUMN "team_id"`);
        await queryRunner.query(`ALTER TABLE "provider_keys" DROP CONSTRAINT "pk_provider_keys"`);
        await queryRunner.query(`ALTER TABLE "provider_keys" ADD CONSTRAINT "pk_provider_keys" PRIMARY KEY ("provider")`);
        await queryRunner.query(`ALTER TABLE "provider_keys" DROP COLUMN "team_id"`);
        await queryRunner.query(`ALTER TABLE "projects" DROP CONSTRAINT "pk_projects"`);
        await queryRunner.query(`ALTER TABLE "projects" ADD CONSTRAINT "pk_projects" PRIMARY KEY ("project_id")`);
        await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "team_id"`);
        await queryRunner.query(`ALTER TABLE "github_tokens" DROP CONSTRAINT "pk_github_tokens"`);
        await queryRunner.query(`ALTER TABLE "github_tokens" ADD CONSTRAINT "pk_github_tokens" PRIMARY KEY ("name")`);
        await queryRunner.query(`ALTER TABLE "github_tokens" DROP COLUMN "team_id"`);
        await queryRunner.query(`ALTER TABLE "facts" DROP COLUMN "team_id"`);
        await queryRunner.query(`ALTER TABLE "channels" DROP COLUMN "team_id"`);
        await queryRunner.query(`DROP TABLE "tenants"`);
        await queryRunner.query(`DROP INDEX "public"."idx_employee_skills_employee_id_team_id"`);
        await queryRunner.query(`DROP TABLE "employee_skills"`);
        await queryRunner.query(`CREATE INDEX "idx_worklog_project_owner_bot_completed_at" ON "worklog" ("owner_bot", "project", "completed_at") `);
        await queryRunner.query(`CREATE INDEX "idx_tasks_project_status_owner" ON "tasks" ("project", "owner", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_tasks_project_owner_norm" ON "tasks" ("project", "norm", "owner") WHERE (status = 'open'::text)`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_github_tokens_is_default" ON "github_tokens" ("is_default") WHERE is_default`);
    }

}
