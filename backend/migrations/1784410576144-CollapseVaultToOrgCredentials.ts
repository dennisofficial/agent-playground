import { MigrationInterface, QueryRunner } from "typeorm";

export class CollapseVaultToOrgCredentials1784410576144 implements MigrationInterface {
    name = 'CollapseVaultToOrgCredentials1784410576144'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "org_credentials" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "org_id" uuid NOT NULL, "anthropic_api_key_enc" text, "openai_api_key_enc" text, "github_pat_enc" text, CONSTRAINT "pk_org_credentials" PRIMARY KEY ("org_id"))`);
        await queryRunner.query(`ALTER TABLE "org_credentials" ADD CONSTRAINT "fk_org_credentials_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        // Drop the retired key-agnostic vault (superseded by the typed org_credentials columns above).
        await queryRunner.query(`DROP TABLE "org_secrets"`);
        await queryRunner.query(`DROP TYPE "public"."org_secrets_key_enum"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."org_secrets_key_enum" AS ENUM('github_pat', 'anthropic_api_key', 'openai_api_key')`);
        await queryRunner.query(`CREATE TABLE "org_secrets" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "org_id" uuid NOT NULL, "key" "public"."org_secrets_key_enum" NOT NULL, "ciphertext" text NOT NULL, CONSTRAINT "pk_org_secrets" PRIMARY KEY ("org_id", "key"))`);
        await queryRunner.query(`ALTER TABLE "org_secrets" ADD CONSTRAINT "fk_org_secrets_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "org_credentials" DROP CONSTRAINT "fk_org_credentials_org_id_organizations"`);
        await queryRunner.query(`DROP TABLE "org_credentials"`);
    }

}
