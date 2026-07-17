import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Replace the single-slot human-input gate (`threads.awaiting_question_id`) with a per-card model: each
 * `ask_question` card now carries its own `answer`/`answeredAt`/`deliveredAt` lifecycle, so the brain may
 * have several questions open at once. `threads.open_question_count` is the denormalized "how many cards
 * await the operator" counter (cheap needs-you signal + WAL realtime); it is backfilled here from the
 * actual unanswered question cards.
 */
export class OpenQuestionCountGate1782860490347 implements MigrationInterface {
  name = 'OpenQuestionCountGate1782860490347';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "awaiting_question_id"`);
    await queryRunner.query(
      `ALTER TABLE "threads" ADD "open_question_count" integer NOT NULL DEFAULT '0'`,
    );
    // Backfill from the cards that are actually still awaiting an answer.
    await queryRunner.query(`
            UPDATE "threads" t SET "open_question_count" = (
                SELECT COUNT(*)::int FROM "messages" m
                WHERE m."thread_id" = t."id" AND m."kind" = 'card'
                  AND m."card" ->> 'type' = 'question_card'
                  AND m."card" ->> 'answer' IS NULL
            )
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "threads" DROP COLUMN "open_question_count"`);
    await queryRunner.query(`ALTER TABLE "threads" ADD "awaiting_question_id" text`);
  }
}
