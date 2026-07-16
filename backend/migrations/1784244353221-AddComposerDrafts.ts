import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The `composer_drafts` / `composer_draft_attachments` tables — server-side composer drafts (see
 * `ComposerDraftEntity`/`ComposerDraftAttachmentEntity`). One draft row per (job, user); many attachment
 * rows per draft.
 */
export class AddComposerDrafts1784244353221 implements MigrationInterface {
  name = 'AddComposerDrafts1784244353221';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "composer_drafts" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "org_id" uuid NOT NULL, "job_id" uuid NOT NULL, "user_id" uuid NOT NULL, "payload" jsonb NOT NULL, CONSTRAINT "pk_composer_drafts" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_composer_drafts_job_id_user_id" ON "composer_drafts" ("job_id", "user_id")`,
    );
    await queryRunner.query(
      `CREATE TABLE "composer_draft_attachments" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "org_id" uuid NOT NULL, "job_id" uuid NOT NULL, "user_id" uuid NOT NULL, "filename" text NOT NULL, "stored_name" text NOT NULL, "kind" text NOT NULL, "size" integer NOT NULL, CONSTRAINT "pk_composer_draft_attachments" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_composer_draft_attachments_job_id_user_id" ON "composer_draft_attachments" ("job_id", "user_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "composer_drafts" ADD CONSTRAINT "fk_composer_drafts_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "composer_drafts" ADD CONSTRAINT "fk_composer_drafts_job_id_jobs" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "composer_drafts" ADD CONSTRAINT "fk_composer_drafts_user_id_users" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "composer_draft_attachments" ADD CONSTRAINT "fk_composer_draft_attachments_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "composer_draft_attachments" ADD CONSTRAINT "fk_composer_draft_attachments_job_id_jobs" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "composer_draft_attachments" ADD CONSTRAINT "fk_composer_draft_attachments_user_id_users" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "composer_draft_attachments" DROP CONSTRAINT "fk_composer_draft_attachments_user_id_users"`,
    );
    await queryRunner.query(
      `ALTER TABLE "composer_draft_attachments" DROP CONSTRAINT "fk_composer_draft_attachments_job_id_jobs"`,
    );
    await queryRunner.query(
      `ALTER TABLE "composer_draft_attachments" DROP CONSTRAINT "fk_composer_draft_attachments_org_id_organizations"`,
    );
    await queryRunner.query(
      `ALTER TABLE "composer_drafts" DROP CONSTRAINT "fk_composer_drafts_user_id_users"`,
    );
    await queryRunner.query(
      `ALTER TABLE "composer_drafts" DROP CONSTRAINT "fk_composer_drafts_job_id_jobs"`,
    );
    await queryRunner.query(
      `ALTER TABLE "composer_drafts" DROP CONSTRAINT "fk_composer_drafts_org_id_organizations"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_composer_draft_attachments_job_id_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "composer_draft_attachments"`);
    await queryRunner.query(
      `DROP INDEX "public"."idx_composer_drafts_job_id_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "composer_drafts"`);
  }
}
