import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add the NULLABLE `github_identity_mode` column to `org_credentials` — a per-org preference for which
 * credential AUTHORS identity-bearing writes (commit author, PR creation, PR/issue comments, reviews):
 * 'pat' (the PAT owner) or 'app' (the App bot). NULL = unset = resolves as 'pat' at resolve time, so
 * existing rows are untouched behaviorally. Nullable by design (NULL is a meaningful "unset" state); the
 * CHECK constraint is not violated by NULL, so no default is needed. Orthogonal to `github_auth_mode`.
 */
export class AddGithubIdentityMode1783910000000 implements MigrationInterface {
  name = 'AddGithubIdentityMode1783910000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "org_credentials" ADD "github_identity_mode" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_credentials" ADD CONSTRAINT "CHK_org_credentials_github_identity_mode" CHECK ("github_identity_mode" IN ('pat', 'app'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "org_credentials" DROP CONSTRAINT "CHK_org_credentials_github_identity_mode"`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_credentials" DROP COLUMN "github_identity_mode"`,
    );
  }
}
