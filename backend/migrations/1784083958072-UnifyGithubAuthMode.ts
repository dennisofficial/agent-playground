import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Unify in-sandbox GitHub auth onto the single `github_auth_mode` knob and drop the now-dead
 * `github_identity_mode` column (`AddGithubIdentityMode1783910000000`). In-sandbox transport, commit
 * identity, and gh/PR token are now all derived from `github_auth_mode` alone (`CredentialResolver`),
 * so a separate identity preference is no longer meaningful.
 *
 * Existing `github_auth_mode = 'app'` rows were set by the App-connect callback's auto-flip, which this
 * change removes — not by a deliberate owner choice — so `up()` resets them to `'pat'` (pusher = author
 * everywhere, in-sandbox authoring returns to PAT by default). Owners who want App-in-sandbox re-toggle
 * it via Settings.
 *
 * `down()` re-adds the column + CHECK constraint (mirroring the original `AddGithubIdentityMode.up`), but
 * does NOT restore the per-row `github_auth_mode` values reset by `up()` — those prior values are not
 * recoverable, and the reset to `'pat'` is the intended end state of this migration either way.
 */
export class UnifyGithubAuthMode1784010000000 implements MigrationInterface {
  name = 'UnifyGithubAuthMode1784010000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "org_credentials" SET "github_auth_mode" = 'pat' WHERE "github_auth_mode" = 'app'`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_credentials" DROP CONSTRAINT "CHK_org_credentials_github_identity_mode"`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_credentials" DROP COLUMN "github_identity_mode"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "org_credentials" ADD "github_identity_mode" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_credentials" ADD CONSTRAINT "CHK_org_credentials_github_identity_mode" CHECK ("github_identity_mode" IN ('pat', 'app'))`,
    );
  }
}
