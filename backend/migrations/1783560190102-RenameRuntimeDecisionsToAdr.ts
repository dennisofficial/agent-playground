import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Runtime promoted-decision rename: `.atlas/decisions` became `.atlas/adr`, and the DB follows that
 * vocabulary. Hand-written because this must preserve existing promoted decisions and promotion state.
 */
export class RenameRuntimeDecisionsToAdr1783560190102 implements MigrationInterface {
  name = 'RenameRuntimeDecisionsToAdr1783560190102';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "jobs" RENAME COLUMN "ledger_promotion_status" TO "adr_promotion_status"`);
    await q.query(`ALTER TABLE "jobs" RENAME COLUMN "ledger_promoted_at" TO "adr_promoted_at"`);

    await q.query(`ALTER TABLE "repo_decisions" RENAME TO "repo_adrs"`);
    await q.query(`ALTER TABLE "repo_adrs" RENAME CONSTRAINT "pk_repo_decisions" TO "pk_repo_adrs"`);
    await q.query(
      `ALTER TABLE "repo_adrs" RENAME CONSTRAINT "uq_repo_decisions_org_id_repo_id_slug" TO "uq_repo_adrs_org_id_repo_id_slug"`,
    );
    await q.query(
      `ALTER TABLE "repo_adrs" RENAME CONSTRAINT "fk_repo_decisions_org_id_organizations" TO "fk_repo_adrs_org_id_organizations"`,
    );
    await q.query(
      `ALTER TABLE "repo_adrs" RENAME CONSTRAINT "fk_repo_decisions_repo_id_repos" TO "fk_repo_adrs_repo_id_repos"`,
    );
    await q.query(`ALTER INDEX "idx_repo_decisions_org_id_repo_id" RENAME TO "idx_repo_adrs_org_id_repo_id"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER INDEX "idx_repo_adrs_org_id_repo_id" RENAME TO "idx_repo_decisions_org_id_repo_id"`);
    await q.query(
      `ALTER TABLE "repo_adrs" RENAME CONSTRAINT "fk_repo_adrs_repo_id_repos" TO "fk_repo_decisions_repo_id_repos"`,
    );
    await q.query(
      `ALTER TABLE "repo_adrs" RENAME CONSTRAINT "fk_repo_adrs_org_id_organizations" TO "fk_repo_decisions_org_id_organizations"`,
    );
    await q.query(
      `ALTER TABLE "repo_adrs" RENAME CONSTRAINT "uq_repo_adrs_org_id_repo_id_slug" TO "uq_repo_decisions_org_id_repo_id_slug"`,
    );
    await q.query(`ALTER TABLE "repo_adrs" RENAME CONSTRAINT "pk_repo_adrs" TO "pk_repo_decisions"`);
    await q.query(`ALTER TABLE "repo_adrs" RENAME TO "repo_decisions"`);

    await q.query(`ALTER TABLE "jobs" RENAME COLUMN "adr_promoted_at" TO "ledger_promoted_at"`);
    await q.query(`ALTER TABLE "jobs" RENAME COLUMN "adr_promotion_status" TO "ledger_promotion_status"`);
  }
}
