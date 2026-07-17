import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Replace the singleton `org_credentials.claude_oauth_token_enc` column with a LIST table
 * `claude_credentials` (one row per setup-token or personal OAuth login) plus a per-org
 * `organizations.selected_claude_credential_id` pointer naming the ONE active credential. The legacy
 * ciphertext is portable verbatim (same cipher + key) so the existing token is copied — never decrypted —
 * into an "Imported setup-token" row that becomes each org's initial selection. The legacy column is left
 * in place but vestigial: the resolver never reads it again after this migration.
 */
export class AddClaudeCredentials1783697526170 implements MigrationInterface {
  name = 'AddClaudeCredentials1783697526170';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "claude_credentials" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "org_id" uuid NOT NULL, "label" text NOT NULL, "kind" text NOT NULL, "access_token_enc" text NOT NULL, "refresh_token_enc" text, "expires_at" TIMESTAMP WITH TIME ZONE, "scopes" text, "subscription_type" text, "account_email" text, "status" text NOT NULL DEFAULT 'active', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "last_refreshed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_claude_credentials" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "claude_credentials" ADD CONSTRAINT "FK_claude_credentials_org_id" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_claude_credentials_org_id" ON "claude_credentials" ("org_id")`,
    );

    await queryRunner.query(`ALTER TABLE "organizations" ADD "selected_claude_credential_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD CONSTRAINT "FK_organizations_selected_claude_credential" FOREIGN KEY ("selected_claude_credential_id") REFERENCES "claude_credentials"("id") ON DELETE SET NULL`,
    );

    // Data-migrate the legacy token in ONE CTE so each org points at its own imported row. The
    // ciphertext is copied verbatim — same cipher + key — NEVER decrypted here.
    await queryRunner.query(`
            WITH inserted AS (
              INSERT INTO "claude_credentials" (org_id, label, kind, access_token_enc, status)
              SELECT oc.org_id, 'Imported setup-token', 'setup_token', oc.claude_oauth_token_enc, 'active'
              FROM "org_credentials" oc
              WHERE oc.scope = '*' AND oc.claude_oauth_token_enc IS NOT NULL
              RETURNING id, org_id
            )
            UPDATE "organizations" o
            SET "selected_claude_credential_id" = inserted.id
            FROM inserted
            WHERE o.id = inserted.org_id
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP CONSTRAINT "FK_organizations_selected_claude_credential"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP COLUMN "selected_claude_credential_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_claude_credentials_org_id"`);
    await queryRunner.query(`DROP TABLE "claude_credentials"`);
  }
}
