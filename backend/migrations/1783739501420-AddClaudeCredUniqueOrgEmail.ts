import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Personal Claude credentials become unique per org by account email: a partial unique index on
 * `claude_credentials(org_id, account_email) WHERE kind = 'personal' AND account_email IS NOT NULL`.
 * Setup-tokens (`account_email` NULL) are excluded, so any number of them still coexist.
 *
 * Pre-existing duplicates MUST be deduped before the index is created or `CREATE UNIQUE INDEX` fails.
 * We keep the newest row per (org_id, account_email) group and, for any org whose selected pointer lands
 * on a losing row, repoint it onto the surviving (kept) row so no org loses its active credential.
 */
export class AddClaudeCredUniqueOrgEmail1783739501420 implements MigrationInterface {
  name = 'AddClaudeCredUniqueOrgEmail1783739501420';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Repoint selected pointers off soon-to-be-deleted duplicate rows onto the surviving (newest) row.
    await queryRunner.query(`
      WITH ranked AS (
        SELECT id, org_id, account_email,
               row_number() OVER (PARTITION BY org_id, account_email
                                  ORDER BY last_refreshed_at DESC NULLS LAST, created_at DESC, id) AS rn
        FROM claude_credentials
        WHERE kind = 'personal' AND account_email IS NOT NULL
      ),
      keep AS (SELECT org_id, account_email, id AS keep_id FROM ranked WHERE rn = 1)
      UPDATE organizations o
      SET selected_claude_credential_id = k.keep_id
      FROM ranked r JOIN keep k USING (org_id, account_email)
      WHERE r.rn > 1 AND o.selected_claude_credential_id = r.id
    `);

    // 2. Delete the losing duplicates.
    await queryRunner.query(`
      WITH ranked AS (
        SELECT id,
               row_number() OVER (PARTITION BY org_id, account_email
                                  ORDER BY last_refreshed_at DESC NULLS LAST, created_at DESC, id) AS rn
        FROM claude_credentials
        WHERE kind = 'personal' AND account_email IS NOT NULL
      )
      DELETE FROM claude_credentials c
      USING ranked r
      WHERE c.id = r.id AND r.rn > 1
    `);

    // 3. Create the partial unique index.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_claude_cred_org_email_personal" ON "claude_credentials" ("org_id", "account_email") WHERE kind = 'personal' AND account_email IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Only the index is reversible; the dedupe is a one-way data cleanup (acceptable).
    await queryRunner.query(`DROP INDEX "public"."uq_claude_cred_org_email_personal"`);
  }
}
