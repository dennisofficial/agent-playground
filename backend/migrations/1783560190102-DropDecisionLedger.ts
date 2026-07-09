import { MigrationInterface, QueryRunner } from "typeorm";

export class DropDecisionLedger1783560190102 implements MigrationInterface {
    name = 'DropDecisionLedger1783560190102'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "ledger_promoted_at"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "ledger_promotion_status"`);
        await queryRunner.query(`DROP TABLE "repo_decisions"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "repo_decisions" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "org_id" uuid NOT NULL, "repo_id" uuid NOT NULL, "slug" text NOT NULL, "title" text NOT NULL DEFAULT '', "status" text NOT NULL DEFAULT 'accepted', "tags" text array NOT NULL DEFAULT '{}', "source_job" text, "supersedes" text array NOT NULL DEFAULT '{}', "superseded_by" text, "governs_paths" text array NOT NULL DEFAULT '{}', "content_hash" text NOT NULL DEFAULT '', "flagged" boolean NOT NULL DEFAULT false, "last_reconciled" TIMESTAMP WITH TIME ZONE, CONSTRAINT "uq_repo_decisions_org_id_repo_id_slug" UNIQUE ("org_id", "repo_id", "slug"), CONSTRAINT "pk_repo_decisions" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_repo_decisions_org_id_repo_id" ON "repo_decisions" ("org_id", "repo_id") `);
        await queryRunner.query(`ALTER TABLE "repo_decisions" ADD CONSTRAINT "fk_repo_decisions_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "repo_decisions" ADD CONSTRAINT "fk_repo_decisions_repo_id_repos" FOREIGN KEY ("repo_id") REFERENCES "repos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD "ledger_promotion_status" text`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD "ledger_promoted_at" TIMESTAMP WITH TIME ZONE`);
    }

}
