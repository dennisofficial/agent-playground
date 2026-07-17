import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add the three PLAINTEXT (non-secret) GitHub App connection columns to `org_credentials`:
 * `github_app_installation_id` (nullable bigint — GitHub installation ids are integers, TypeORM maps
 * bigint → string), `github_app_installation_account` (display/audit login), and `github_auth_mode`
 * ('pat' | 'app', default 'pat' so every existing row is untouched behaviorally). The partial UNIQUE
 * index enforces one installation → at most one org (blocks cross-tenant installation takeover).
 */
export class AddGithubAppAuth1783732874293 implements MigrationInterface {
  name = 'AddGithubAppAuth1783732874293';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "org_credentials" ADD "github_app_installation_id" bigint`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_credentials" ADD "github_app_installation_account" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_credentials" ADD "github_auth_mode" text NOT NULL DEFAULT 'pat'`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_credentials" ADD CONSTRAINT "CHK_org_credentials_github_auth_mode" CHECK ("github_auth_mode" IN ('pat', 'app'))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_org_credentials_github_app_installation_id" ON "org_credentials" ("github_app_installation_id") WHERE "github_app_installation_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_org_credentials_github_app_installation_id"`);
    await queryRunner.query(
      `ALTER TABLE "org_credentials" DROP CONSTRAINT "CHK_org_credentials_github_auth_mode"`,
    );
    await queryRunner.query(`ALTER TABLE "org_credentials" DROP COLUMN "github_auth_mode"`);
    await queryRunner.query(
      `ALTER TABLE "org_credentials" DROP COLUMN "github_app_installation_account"`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_credentials" DROP COLUMN "github_app_installation_id"`,
    );
  }
}
