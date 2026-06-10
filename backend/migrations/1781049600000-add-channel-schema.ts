import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Durable chat history: the per-surface channel log + per-bot cursors. Hand-written, mirroring the
 * entities in `@workspace/shared/schemas` (channel_messages / bot_cursors). The LangGraph
 * checkpoint tables are NOT here — `PostgresSaver.setup()` owns those.
 */
export class AddChannelSchema1781049600000 implements MigrationInterface {
  name = 'AddChannelSchema1781049600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ─── channel_messages (the append-only conversation log) ───────────────
    await queryRunner.query(`
      CREATE TABLE "channel_messages" (
        "id"            text PRIMARY KEY,
        "seq"           bigint NOT NULL,
        "surface_id"    text NOT NULL,
        "author"        text NOT NULL,
        "author_id"     text NOT NULL,
        "author_bot_id" text,
        "text"          text NOT NULL,
        "created_at"    timestamptz NOT NULL DEFAULT now(),
        "updated_at"    timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_channel_messages_surface_id_seq" ON "channel_messages" ("surface_id", "seq")`,
    );

    // ─── bot_cursors (per-bot consumption high-water marks) ────────────────
    await queryRunner.query(`
      CREATE TABLE "bot_cursors" (
        "bot_id"           text NOT NULL,
        "surface_id"       text NOT NULL,
        "delivered_up_to"  bigint NOT NULL,
        "updated_at"       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_bot_cursors" PRIMARY KEY ("bot_id", "surface_id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "bot_cursors"`);
    await queryRunner.query(`DROP TABLE "channel_messages"`);
  }
}
