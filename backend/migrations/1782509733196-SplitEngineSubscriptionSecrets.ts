import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The SDK harness now runs SUBSCRIPTION-ONLY (no api_key mode). Replace the single org credential
 * `engine_auth_mode` + `engine_auth_secret_enc` with per-engine subscription secrets:
 *   - `claude_oauth_token_enc` — Claude OAuth token (preserves the old single secret, which was Claude's)
 *   - `codex_auth_secret_enc`  — Codex auth.json / token
 *
 * (Pruned the generator's unrelated noise: the parallel `threads.pending_decisions` work and the
 * pgvector HNSW / partial-unique index churn the generator re-emits — those are not part of this change.)
 */
export class SplitEngineSubscriptionSecrets1782509733196 implements MigrationInterface {
  name = 'SplitEngineSubscriptionSecrets1782509733196';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "org_credentials" ADD "claude_oauth_token_enc" text`);
    await queryRunner.query(`ALTER TABLE "org_credentials" ADD "codex_auth_secret_enc" text`);
    // Preserve existing subscription secrets — the old single column only ever held Claude OAuth tokens.
    await queryRunner.query(
      `UPDATE "org_credentials" SET "claude_oauth_token_enc" = "engine_auth_secret_enc" WHERE "engine_auth_secret_enc" IS NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE "org_credentials" DROP COLUMN "engine_auth_mode"`);
    await queryRunner.query(`ALTER TABLE "org_credentials" DROP COLUMN "engine_auth_secret_enc"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "org_credentials" ADD "engine_auth_secret_enc" text`);
    await queryRunner.query(
      `ALTER TABLE "org_credentials" ADD "engine_auth_mode" text NOT NULL DEFAULT 'api_key'`,
    );
    // Restore the single secret from the Claude column (the only one the old shape could represent).
    await queryRunner.query(
      `UPDATE "org_credentials" SET "engine_auth_secret_enc" = "claude_oauth_token_enc", "engine_auth_mode" = 'subscription' WHERE "claude_oauth_token_enc" IS NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE "org_credentials" DROP COLUMN "codex_auth_secret_enc"`);
    await queryRunner.query(`ALTER TABLE "org_credentials" DROP COLUMN "claude_oauth_token_enc"`);
  }
}
