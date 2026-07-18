import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAgentCredentials1784390545626 implements MigrationInterface {
  name = 'AddAgentCredentials1784390545626';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."agent_credentials_provider_enum" AS ENUM('claude', 'codex')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."agent_credentials_kind_enum" AS ENUM('personal', 'setup_token')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."agent_credentials_status_enum" AS ENUM('active', 'needs_reauth', 'error')`,
    );
    await queryRunner.query(
      `CREATE TABLE "agent_credentials" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "org_id" uuid NOT NULL, "provider" "public"."agent_credentials_provider_enum" NOT NULL, "kind" "public"."agent_credentials_kind_enum" NOT NULL, "label" text NOT NULL, "account_email" text, "subscription_type" text, "status" "public"."agent_credentials_status_enum" NOT NULL DEFAULT 'active', "scopes" text, "material_enc" text NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE, "last_refreshed_at" TIMESTAMP WITH TIME ZONE, "selected" boolean NOT NULL DEFAULT false, "usage_snapshot" jsonb, CONSTRAINT "pk_agent_credentials" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_agent_cred_org_provider_email_personal" ON "agent_credentials" ("org_id", "provider", "account_email") WHERE kind = 'personal' AND account_email IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_agent_cred_org_provider_selected" ON "agent_credentials" ("org_id", "provider") WHERE selected`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_agent_credentials_org_id" ON "agent_credentials" ("org_id") `,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."org_secrets_key_enum" RENAME TO "org_secrets_key_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."org_secrets_key_enum" AS ENUM('github_pat', 'anthropic_api_key', 'openai_api_key')`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_secrets" ALTER COLUMN "key" TYPE "public"."org_secrets_key_enum" USING "key"::"text"::"public"."org_secrets_key_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."org_secrets_key_enum_old"`);
    await queryRunner.query(
      `ALTER TABLE "agent_credentials" ADD CONSTRAINT "fk_agent_credentials_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_credentials" DROP CONSTRAINT "fk_agent_credentials_org_id_organizations"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."org_secrets_key_enum_old" AS ENUM('github_pat', 'anthropic_api_key', 'openai_api_key', 'codex_auth')`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_secrets" ALTER COLUMN "key" TYPE "public"."org_secrets_key_enum_old" USING "key"::"text"::"public"."org_secrets_key_enum_old"`,
    );
    await queryRunner.query(`DROP TYPE "public"."org_secrets_key_enum"`);
    await queryRunner.query(
      `ALTER TYPE "public"."org_secrets_key_enum_old" RENAME TO "org_secrets_key_enum"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_agent_credentials_org_id"`);
    await queryRunner.query(`DROP INDEX "public"."uq_agent_cred_org_provider_selected"`);
    await queryRunner.query(`DROP INDEX "public"."uq_agent_cred_org_provider_email_personal"`);
    await queryRunner.query(`DROP TABLE "agent_credentials"`);
    await queryRunner.query(`DROP TYPE "public"."agent_credentials_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."agent_credentials_kind_enum"`);
    await queryRunner.query(`DROP TYPE "public"."agent_credentials_provider_enum"`);
  }
}
