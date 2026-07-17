import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Rename the intake queue `stimuli` → `inbound_messages` (`StimulusEntity` → `InboundMessageEntity`)
 * and the transcript log `messages` → `transcript_messages` (`MessageEntity` → `TranscriptMessageEntity`)
 * so the schema matches the new `Message`-union vocabulary (Stimulus is retired). Also adds the
 * `inbound_messages.type` discriminant (the Message-union `type`, additive alongside the existing
 * coarser `kind` chat/event split) and backfills it from `kind` for pre-existing rows.
 *
 * DATA-PRESERVING: the generator wanted DROP+CREATE for both tables (which would lose live rows,
 * and — for `messages` — cascade-drop `subagents.parent_message_id`'s FK) — hand-rewritten to
 * `ALTER TABLE … RENAME`, following the `RenameWorktreeToWorkspace` migration's pattern. Renaming a
 * PK constraint also renames its backing index; secondary indexes (including the two partial unique
 * ones) are renamed explicitly. `subagents.fk_..._messages` is renamed too since a FK's name embeds
 * the referenced table even though Postgres tracks the reference by oid, not name.
 */
export class RenameStimuliAndMessages1784160903846 implements MigrationInterface {
  name = 'RenameStimuliAndMessages1784160903846';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ─── messages → transcript_messages ────────────────────────────────────
    await queryRunner.query(`ALTER TABLE "messages" RENAME TO "transcript_messages"`);
    await queryRunner.query(
      `ALTER TABLE "transcript_messages" RENAME CONSTRAINT "pk_messages" TO "pk_transcript_messages"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transcript_messages" RENAME CONSTRAINT "fk_messages_job_id_jobs" TO "fk_transcript_messages_job_id_jobs"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transcript_messages" RENAME CONSTRAINT "fk_messages_thread_id_threads" TO "fk_transcript_messages_thread_id_threads"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transcript_messages" RENAME CONSTRAINT "fk_messages_subagent_id_subagents" TO "fk_transcript_messages_subagent_id_subagents"`,
    );
    await queryRunner.query(
      `ALTER TABLE "subagents" RENAME CONSTRAINT "fk_subagents_parent_message_id_messages" TO "fk_subagents_parent_message_id_transcript_messages"`,
    );
    await queryRunner.query(
      `ALTER INDEX "idx_messages_job_id_created_at" RENAME TO "idx_transcript_messages_job_id_created_at"`,
    );
    await queryRunner.query(
      `ALTER INDEX "idx_messages_thread_id_created_at" RENAME TO "idx_transcript_messages_thread_id_created_at"`,
    );
    await queryRunner.query(
      `ALTER INDEX "idx_messages_subagent_id" RENAME TO "idx_transcript_messages_subagent_id"`,
    );
    await queryRunner.query(
      `ALTER INDEX "ux_messages_idem_key" RENAME TO "ux_transcript_messages_idem_key"`,
    );

    // ─── stimuli → inbound_messages ─────────────────────────────────────────
    await queryRunner.query(`ALTER TABLE "stimuli" RENAME TO "inbound_messages"`);
    await queryRunner.query(
      `ALTER TABLE "inbound_messages" RENAME CONSTRAINT "pk_stimuli" TO "pk_inbound_messages"`,
    );
    await queryRunner.query(
      `ALTER TABLE "inbound_messages" RENAME CONSTRAINT "fk_stimuli_org_id_organizations" TO "fk_inbound_messages_org_id_organizations"`,
    );
    await queryRunner.query(
      `ALTER TABLE "inbound_messages" RENAME CONSTRAINT "fk_stimuli_repo_id_repos" TO "fk_inbound_messages_repo_id_repos"`,
    );
    await queryRunner.query(
      `ALTER TABLE "inbound_messages" RENAME CONSTRAINT "fk_stimuli_job_id_jobs" TO "fk_inbound_messages_job_id_jobs"`,
    );
    await queryRunner.query(
      `ALTER INDEX "idx_stimuli_org_id_repo_id" RENAME TO "idx_inbound_messages_org_id_repo_id"`,
    );
    await queryRunner.query(
      `ALTER INDEX "idx_stimuli_org_id_repo_id_source_dedupe_key" RENAME TO "idx_inbound_messages_org_id_repo_id_source_dedupe_key"`,
    );

    // ─── new discriminant column (additive), backfilled from `kind` ────────
    await queryRunner.query(`ALTER TABLE "inbound_messages" ADD COLUMN "type" text`);
    await queryRunner.query(
      `UPDATE "inbound_messages" SET "type" = CASE WHEN "kind" = 'event' THEN 'event' WHEN "author_id" = 'U-SYSTEM' THEN 'seed' ELSE 'user' END`,
    );
    await queryRunner.query(`ALTER TABLE "inbound_messages" ALTER COLUMN "type" SET NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "inbound_messages" DROP COLUMN "type"`);

    // ─── inbound_messages → stimuli ─────────────────────────────────────────
    await queryRunner.query(
      `ALTER INDEX "idx_inbound_messages_org_id_repo_id_source_dedupe_key" RENAME TO "idx_stimuli_org_id_repo_id_source_dedupe_key"`,
    );
    await queryRunner.query(
      `ALTER INDEX "idx_inbound_messages_org_id_repo_id" RENAME TO "idx_stimuli_org_id_repo_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "inbound_messages" RENAME CONSTRAINT "fk_inbound_messages_job_id_jobs" TO "fk_stimuli_job_id_jobs"`,
    );
    await queryRunner.query(
      `ALTER TABLE "inbound_messages" RENAME CONSTRAINT "fk_inbound_messages_repo_id_repos" TO "fk_stimuli_repo_id_repos"`,
    );
    await queryRunner.query(
      `ALTER TABLE "inbound_messages" RENAME CONSTRAINT "fk_inbound_messages_org_id_organizations" TO "fk_stimuli_org_id_organizations"`,
    );
    await queryRunner.query(
      `ALTER TABLE "inbound_messages" RENAME CONSTRAINT "pk_inbound_messages" TO "pk_stimuli"`,
    );
    await queryRunner.query(`ALTER TABLE "inbound_messages" RENAME TO "stimuli"`);

    // ─── transcript_messages → messages ─────────────────────────────────────
    await queryRunner.query(
      `ALTER INDEX "ux_transcript_messages_idem_key" RENAME TO "ux_messages_idem_key"`,
    );
    await queryRunner.query(
      `ALTER INDEX "idx_transcript_messages_subagent_id" RENAME TO "idx_messages_subagent_id"`,
    );
    await queryRunner.query(
      `ALTER INDEX "idx_transcript_messages_thread_id_created_at" RENAME TO "idx_messages_thread_id_created_at"`,
    );
    await queryRunner.query(
      `ALTER INDEX "idx_transcript_messages_job_id_created_at" RENAME TO "idx_messages_job_id_created_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "subagents" RENAME CONSTRAINT "fk_subagents_parent_message_id_transcript_messages" TO "fk_subagents_parent_message_id_messages"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transcript_messages" RENAME CONSTRAINT "fk_transcript_messages_subagent_id_subagents" TO "fk_messages_subagent_id_subagents"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transcript_messages" RENAME CONSTRAINT "fk_transcript_messages_thread_id_threads" TO "fk_messages_thread_id_threads"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transcript_messages" RENAME CONSTRAINT "fk_transcript_messages_job_id_jobs" TO "fk_messages_job_id_jobs"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transcript_messages" RENAME CONSTRAINT "pk_transcript_messages" TO "pk_messages"`,
    );
    await queryRunner.query(`ALTER TABLE "transcript_messages" RENAME TO "messages"`);
  }
}
