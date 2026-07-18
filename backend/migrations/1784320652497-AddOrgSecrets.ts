import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrgSecrets1784320652497 implements MigrationInterface {
  name = 'AddOrgSecrets1784320652497';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."org_secrets_key_enum" AS ENUM('github_pat', 'anthropic_api_key', 'openai_api_key', 'codex_auth')`,
    );
    await queryRunner.query(
      `CREATE TABLE "org_secrets" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "org_id" uuid NOT NULL, "key" "public"."org_secrets_key_enum" NOT NULL, "ciphertext" text NOT NULL, CONSTRAINT "pk_org_secrets" PRIMARY KEY ("org_id", "key"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_secrets" ADD CONSTRAINT "fk_org_secrets_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "org_secrets" DROP CONSTRAINT "fk_org_secrets_org_id_organizations"`,
    );
    await queryRunner.query(`DROP TABLE "org_secrets"`);
    await queryRunner.query(`DROP TYPE "public"."org_secrets_key_enum"`);
  }
}
