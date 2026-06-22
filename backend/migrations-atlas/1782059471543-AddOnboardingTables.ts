import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The onboarding layer's two tables. Pruned of the generator's noise (it tried to drop/recreate every
 * pre-existing FK, the pgvector HNSW index, and the stimuli partial-unique index, plus cosmetic default
 * churn — all already correct from the init migration). NO team_id FK on these tables on purpose: an
 * OAuth install can land before its `atlas_teams` row exists, and credentials are written independently
 * of team creation — a FK would impose an ordering that breaks self-service onboarding.
 */
export class AddOnboardingTables1782059471543 implements MigrationInterface {
    name = 'AddOnboardingTables1782059471543'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "atlas_tenant_credentials" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "team_id" text NOT NULL, "scope" text NOT NULL DEFAULT '*', "anthropic_api_key_enc" text, "openai_api_key_enc" text, "github_pat_enc" text, "engine_auth_mode" text NOT NULL DEFAULT 'api_key', "engine_auth_secret_enc" text, CONSTRAINT "pk_atlas_tenant_credentials" PRIMARY KEY ("team_id", "scope"))`);
        await queryRunner.query(`CREATE INDEX "idx_atlas_tenant_credentials_team_id" ON "atlas_tenant_credentials" ("team_id") `);
        await queryRunner.query(`CREATE TABLE "atlas_slack_installations" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "team_id" text NOT NULL, "bot_token_enc" text NOT NULL, "bot_user_id" text, "scopes" text, "team_name" text, "uninstalled_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "pk_atlas_slack_installations" PRIMARY KEY ("team_id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "atlas_slack_installations"`);
        await queryRunner.query(`DROP INDEX "public"."idx_atlas_tenant_credentials_team_id"`);
        await queryRunner.query(`DROP TABLE "atlas_tenant_credentials"`);
    }

}
