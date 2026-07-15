import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Collapse the two-table worktree-secrets model (a named `org_worktree_secrets` VALUE + a separate
 * `org_worktree_secret_grants` authorising it for a repo+path) into ONE `org_worktree_secret_files`
 * table keyed by (org_id, repo_id, path) with the value inline. A single row is now the value, the
 * authority, AND the render instruction.
 *
 * The backfill + old-table drop is guarded on the old tables EXISTING, so this runs cleanly whether
 * the DB has them (prod) or not (a freshly-migrated dev/test DB that never created them). When two
 * valued grants target the same (org, repo, path) — which the old PK permitted but the new one forbids
 * — it keeps the most-recently-updated value (DISTINCT ON … ORDER BY updated_at DESC) and RAISE NOTICEs
 * exactly which destinations were auto-resolved and which name won, so the choice is visible in the
 * migration log. It also announces any inert ungranted values it is about to drop.
 */
export class CollapseWorktreeSecretFiles1783304635651 implements MigrationInterface {
  name = 'CollapseWorktreeSecretFiles1783304635651';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "org_worktree_secret_files" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "org_id" uuid NOT NULL, "repo_id" uuid NOT NULL, "path" text NOT NULL, "value_enc" text NOT NULL, "label" text, CONSTRAINT "pk_org_worktree_secret_files" PRIMARY KEY ("org_id", "repo_id", "path"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_org_worktree_secret_files_org_id_repo_id" ON "org_worktree_secret_files" ("org_id", "repo_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_org_worktree_secret_files_org_id" ON "org_worktree_secret_files" ("org_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "org_worktree_secret_files" ADD CONSTRAINT "fk_org_worktree_secret_files_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_worktree_secret_files" ADD CONSTRAINT "fk_org_worktree_secret_files_repo_id_repos" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // Backfill + drop the old two-table model — only where it exists.
    await queryRunner.query(`
DO $$
DECLARE r RECORD;
BEGIN
  IF to_regclass('public.org_worktree_secret_grants') IS NOT NULL
     AND to_regclass('public.org_worktree_secrets') IS NOT NULL THEN

    -- Resolution notice: the old (org, repo, name, path) PK allowed two DIFFERENT names to target the same
    -- (org, repo, path); the new PK forbids it. We keep the most-recently-updated value per destination
    -- (below) — announce each auto-resolved destination + the winning name so the choice is auditable.
    FOR r IN
      SELECT g.org_id, g.repo_id, g.path,
             (array_agg(g.name ORDER BY s.updated_at DESC))[1] AS winner,
             count(*) AS n
      FROM org_worktree_secret_grants g
      JOIN org_worktree_secrets s ON s.org_id = g.org_id AND s.name = g.name
      GROUP BY g.org_id, g.repo_id, g.path
      HAVING count(*) > 1
    LOOP
      RAISE NOTICE 'CollapseWorktreeSecretFiles: % valued grants target (org=%, repo=%, path=%) — keeping newest "%"', r.n, r.org_id, r.repo_id, r.path, r.winner;
    END LOOP;

    -- Visibility: a value with no grant is inert (never rendered) and will be dropped with the old table.
    -- Announce each so the drop is operator-visible in the migration log — grant anything worth keeping first.
    FOR r IN
      SELECT s.org_id, s.name
      FROM org_worktree_secrets s
      WHERE NOT EXISTS (
        SELECT 1 FROM org_worktree_secret_grants g WHERE g.org_id = s.org_id AND g.name = s.name
      )
    LOOP
      RAISE NOTICE 'CollapseWorktreeSecretFiles: dropping ungranted (inert) secret value org=% name=%', r.org_id, r.name;
    END LOOP;

    -- Backfill: each destination becomes ONE secret file row, taking the most-recently-updated value when
    -- several grants collide on it (the name rides along as the display label).
    INSERT INTO org_worktree_secret_files (org_id, repo_id, path, value_enc, label, created_at, updated_at)
    SELECT DISTINCT ON (g.org_id, g.repo_id, g.path)
           g.org_id, g.repo_id, g.path, s.value_enc, g.name, now(), now()
    FROM org_worktree_secret_grants g
    JOIN org_worktree_secrets s ON s.org_id = g.org_id AND s.name = g.name
    ORDER BY g.org_id, g.repo_id, g.path, s.updated_at DESC;

    DROP TABLE org_worktree_secret_grants;
    DROP TABLE org_worktree_secrets;
  END IF;
END $$;
        `);
  }

  public async down(): Promise<void> {
    // Irreversible: the collapse discards the value/authority separation and any inert ungranted
    // values. Restoring the two-table split from the merged rows is not supported.
    throw new Error('CollapseWorktreeSecretFiles is irreversible');
  }
}
