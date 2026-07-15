import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reconciles all 4 of the DB's remaining TypeORM-default-named objects (FK_/IDX_/CHK_, created by
 * hand-written migrations) to the repo's CustomNamingStrategy names (fk_/idx_/chk_): the
 * claude_credentials↔organizations FK pair + the claude_credentials.org_id index (entities already
 * declared these correctly — pure rename, no entity change needed) and the org_credentials CHECK
 * (newly modeled via an explicit two-arg `@Check` in this PR). RENAME in place where Postgres supports
 * it (cheaper, no rebuild, and the generator only ever diffs these by name — never by expression
 * text); the CHECK is dropped/re-added under its new name rather than renamed.
 */
export class ReconcileConstraintNaming1784088016344
  implements MigrationInterface
{
  name = 'ReconcileConstraintNaming1784088016344';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "claude_credentials" RENAME CONSTRAINT "FK_claude_credentials_org_id" TO "fk_claude_credentials_org_id_organizations"`,
    );
    await queryRunner.query(
      `ALTER INDEX "public"."IDX_claude_credentials_org_id" RENAME TO "idx_claude_credentials_org_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" RENAME CONSTRAINT "FK_organizations_selected_claude_credential" TO "fk_organizations_selected_claude_credential_claude_credentials"`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_credentials" DROP CONSTRAINT "CHK_org_credentials_github_auth_mode"`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_credentials" ADD CONSTRAINT "chk_org_credentials_github_auth_mode" CHECK (github_auth_mode IN ('pat', 'app'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "org_credentials" DROP CONSTRAINT "chk_org_credentials_github_auth_mode"`,
    );
    await queryRunner.query(
      `ALTER TABLE "org_credentials" ADD CONSTRAINT "CHK_org_credentials_github_auth_mode" CHECK ((github_auth_mode = ANY (ARRAY['pat'::text, 'app'::text])))`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" RENAME CONSTRAINT "fk_organizations_selected_claude_credential_claude_credentials" TO "FK_organizations_selected_claude_credential"`,
    );
    await queryRunner.query(
      `ALTER INDEX "public"."idx_claude_credentials_org_id" RENAME TO "IDX_claude_credentials_org_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "claude_credentials" RENAME CONSTRAINT "fk_claude_credentials_org_id_organizations" TO "FK_claude_credentials_org_id"`,
    );
  }
}
