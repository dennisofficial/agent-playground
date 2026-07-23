import { MigrationInterface, QueryRunner } from 'typeorm';

export class ThreadMessageType1784836663473 implements MigrationInterface {
  name = 'ThreadMessageType1784836663473';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "thread_messages" RENAME COLUMN "kind" TO "type"`);
    await queryRunner.query(
      `ALTER TYPE "public"."thread_messages_kind_enum" RENAME TO "thread_messages_type_enum"`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."thread_messages_type_enum" RENAME TO "thread_messages_type_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."thread_messages_type_enum" AS ENUM('operator', 'answer_question', 'file_answered', 'secret_provided', 'review_comments', 'attachments', 'chat', 'thinking', 'tool', 'approval', 'verdict', 'question', 'secret_request', 'file_request', 'mcp_proposal', 'skill_proposal', 'event', 'compaction', 'untrusted', 'system_shared', 'system_event', 'system_operator', 'system_notice', 'system_reminder', 'build_anchor')`,
    );
    await queryRunner.query(`ALTER TABLE "thread_messages" ALTER COLUMN "type" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "thread_messages" ALTER COLUMN "type" TYPE "public"."thread_messages_type_enum" USING "type"::"text"::"public"."thread_messages_type_enum"`,
    );
    await queryRunner.query(`ALTER TABLE "thread_messages" ALTER COLUMN "type" SET DEFAULT 'chat'`);
    await queryRunner.query(`DROP TYPE "public"."thread_messages_type_enum_old"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."thread_messages_type_enum_old" AS ENUM('build_event', 'card', 'chat', 'thinking', 'tool')`,
    );
    await queryRunner.query(`ALTER TABLE "thread_messages" ALTER COLUMN "type" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "thread_messages" ALTER COLUMN "type" TYPE "public"."thread_messages_type_enum_old" USING "type"::"text"::"public"."thread_messages_type_enum_old"`,
    );
    await queryRunner.query(`ALTER TABLE "thread_messages" ALTER COLUMN "type" SET DEFAULT 'chat'`);
    await queryRunner.query(`DROP TYPE "public"."thread_messages_type_enum"`);
    await queryRunner.query(
      `ALTER TYPE "public"."thread_messages_type_enum_old" RENAME TO "thread_messages_type_enum"`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."thread_messages_type_enum" RENAME TO "thread_messages_kind_enum"`,
    );
    await queryRunner.query(`ALTER TABLE "thread_messages" RENAME COLUMN "type" TO "kind"`);
  }
}
