import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCodexReviewsDropPlanReviews1783115982821 implements MigrationInterface {
  name = 'AddCodexReviewsDropPlanReviews1783115982821';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The async plan-review spine is replaced by the synchronous, Atlas-driven `codex_reviews`. TypeORM's
    // generator can't emit an orphan-table drop (no entity to diff against), so drop it by hand (mirrors
    // the DropWorktreeSeed precedent). Non-reversible: `down` does not restore plan_reviews rows.
    await queryRunner.query(`DROP TABLE IF EXISTS "plan_reviews"`);
    await queryRunner.query(
      `CREATE TABLE "codex_reviews" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "job_id" uuid NOT NULL, "org_id" uuid NOT NULL, "codex_session_id" text, "spec_hash" text, "status" text NOT NULL DEFAULT 'running', "findings" text, "error" text, "resume_count" integer NOT NULL DEFAULT '0', CONSTRAINT "pk_codex_reviews" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_codex_reviews_status" ON "codex_reviews" ("status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_codex_reviews_job_id" ON "codex_reviews" ("job_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "codex_reviews" ADD CONSTRAINT "fk_codex_reviews_job_id_jobs" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "codex_reviews" DROP CONSTRAINT "fk_codex_reviews_job_id_jobs"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_codex_reviews_job_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_codex_reviews_status"`);
    await queryRunner.query(`DROP TABLE "codex_reviews"`);
  }
}
