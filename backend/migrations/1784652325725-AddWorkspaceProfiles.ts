import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWorkspaceProfiles1784652325725 implements MigrationInterface {
  name = 'AddWorkspaceProfiles1784652325725';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."uq_agent_cred_org_provider_email_personal"`);
    await queryRunner.query(`DROP INDEX "public"."uq_agent_cred_org_provider_selected"`);
    await queryRunner.query(
      `CREATE TABLE "workspace_secret_files" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "org_id" uuid NOT NULL, "repo_id" uuid NOT NULL, "path" text NOT NULL, "label" text, "value_enc" text NOT NULL, CONSTRAINT "pk_workspace_secret_files" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_workspace_secret_files_repo_id_path" ON "workspace_secret_files" ("repo_id", "path") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_workspace_secret_files_org_id" ON "workspace_secret_files" ("org_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "workspace_profiles" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "repo_id" uuid NOT NULL, "org_id" uuid NOT NULL, "setup_script" text, "preview_recipe" text, CONSTRAINT "pk_workspace_profiles" PRIMARY KEY ("repo_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_workspace_profiles_org_id" ON "workspace_profiles" ("org_id") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."workspace_mounts_mode_enum" AS ENUM('per-thread', 'shared-ro', 'shared-rw')`,
    );
    await queryRunner.query(
      `CREATE TABLE "workspace_mounts" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "org_id" uuid NOT NULL, "repo_id" uuid NOT NULL, "path" text NOT NULL, "mode" "public"."workspace_mounts_mode_enum" NOT NULL DEFAULT 'per-thread', CONSTRAINT "pk_workspace_mounts" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_workspace_mounts_repo_id_path" ON "workspace_mounts" ("repo_id", "path") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_workspace_mounts_org_id" ON "workspace_mounts" ("org_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "skills" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "org_id" uuid NOT NULL, "repo_id" uuid, "name" text NOT NULL, "description" text, "enabled" boolean NOT NULL DEFAULT true, CONSTRAINT "pk_skills" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "idx_skills_org_id" ON "skills" ("org_id") `);
    await queryRunner.query(
      `CREATE TABLE "mcp_servers" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "org_id" uuid NOT NULL, "repo_id" uuid, "name" text NOT NULL, "enabled" boolean NOT NULL DEFAULT true, CONSTRAINT "pk_mcp_servers" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "idx_mcp_servers_org_id" ON "mcp_servers" ("org_id") `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_agent_credentials_org_id_provider_account_email" ON "agent_credentials" ("org_id", "provider", "account_email") WHERE kind = 'personal' AND account_email IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_agent_credentials_org_id_provider" ON "agent_credentials" ("org_id", "provider") WHERE selected`,
    );
    await queryRunner.query(
      `ALTER TABLE "workspace_secret_files" ADD CONSTRAINT "fk_workspace_secret_files_repo_id_repos" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "workspace_profiles" ADD CONSTRAINT "fk_workspace_profiles_repo_id_repos" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "workspace_mounts" ADD CONSTRAINT "fk_workspace_mounts_repo_id_repos" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "workspace_mounts" DROP CONSTRAINT "fk_workspace_mounts_repo_id_repos"`,
    );
    await queryRunner.query(
      `ALTER TABLE "workspace_profiles" DROP CONSTRAINT "fk_workspace_profiles_repo_id_repos"`,
    );
    await queryRunner.query(
      `ALTER TABLE "workspace_secret_files" DROP CONSTRAINT "fk_workspace_secret_files_repo_id_repos"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_agent_credentials_org_id_provider"`);
    await queryRunner.query(
      `DROP INDEX "public"."idx_agent_credentials_org_id_provider_account_email"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_mcp_servers_org_id"`);
    await queryRunner.query(`DROP TABLE "mcp_servers"`);
    await queryRunner.query(`DROP INDEX "public"."idx_skills_org_id"`);
    await queryRunner.query(`DROP TABLE "skills"`);
    await queryRunner.query(`DROP INDEX "public"."idx_workspace_mounts_org_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_workspace_mounts_repo_id_path"`);
    await queryRunner.query(`DROP TABLE "workspace_mounts"`);
    await queryRunner.query(`DROP TYPE "public"."workspace_mounts_mode_enum"`);
    await queryRunner.query(`DROP INDEX "public"."idx_workspace_profiles_org_id"`);
    await queryRunner.query(`DROP TABLE "workspace_profiles"`);
    await queryRunner.query(`DROP INDEX "public"."idx_workspace_secret_files_org_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_workspace_secret_files_repo_id_path"`);
    await queryRunner.query(`DROP TABLE "workspace_secret_files"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_agent_cred_org_provider_selected" ON "agent_credentials" ("org_id", "provider") WHERE selected`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_agent_cred_org_provider_email_personal" ON "agent_credentials" ("org_id", "provider", "account_email") WHERE ((kind = 'personal'::agent_credentials_kind_enum) AND (account_email IS NOT NULL))`,
    );
  }
}
