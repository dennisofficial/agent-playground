import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drop the global partial UNIQUE index on `org_credentials.github_app_installation_id`. A GitHub App
 * installs once per GitHub account, so a person running several Atlas orgs off the same account could
 * never connect the App to a second org — the callback always collided with the index. Reuse is now
 * gated in application logic (common ownership: you may link an installation to a new org only if you
 * own another org that already holds it), so the DB-level uniqueness is removed.
 */
export class AllowSharedGithubAppInstallation1784040000000 implements MigrationInterface {
  name = 'AllowSharedGithubAppInstallation1784040000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_org_credentials_github_app_installation_id"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_org_credentials_github_app_installation_id" ON "org_credentials" ("github_app_installation_id") WHERE "github_app_installation_id" IS NOT NULL`,
    );
  }
}
