import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Split the conflated `EThreadMessageSource` into a clean author axis (operator/atlas/system/untrusted)
 * plus an orthogonal `audience` axis on thread_messages. Collapses the five `system_*` variants → `system`,
 * mapping the old operator-only variant onto `audience = 'operator_only'` before the collapse. Also drops
 * the redundant denormalized `author` (display name) from `inbound_messages` — the engine ingress row keeps
 * `author_id` + `source`; the rendered display name lives only on the `thread_messages` bubble.
 */
export class SplitMessageSourceAxis1784611592558 implements MigrationInterface {
    name = 'SplitMessageSourceAxis1784611592558'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // inbound_messages: drop the denormalized display name.
        await queryRunner.query(`ALTER TABLE "inbound_messages" DROP COLUMN "author"`);

        // thread_messages: add the audience axis (default shared).
        await queryRunner.query(`CREATE TYPE "public"."thread_messages_audience_enum" AS ENUM('operator_only', 'shared')`);
        await queryRunner.query(`ALTER TABLE "thread_messages" ADD "audience" "public"."thread_messages_audience_enum" NOT NULL DEFAULT 'shared'`);
        // Preserve the old system_operator → operator-only distinction before collapsing the source values.
        await queryRunner.query(`UPDATE "thread_messages" SET "audience" = 'operator_only' WHERE "source" = 'system_operator'`);

        // thread_messages.source: operator/atlas/system_* → operator/atlas/system/untrusted. Go via text so
        // the system_* → system remap is possible (those values aren't in the new enum for a direct cast).
        await queryRunner.query(`ALTER TABLE "thread_messages" ALTER COLUMN "source" TYPE text USING "source"::text`);
        await queryRunner.query(`UPDATE "thread_messages" SET "source" = 'system' WHERE "source" LIKE 'system\\_%'`);
        await queryRunner.query(`DROP TYPE "public"."thread_messages_source_enum"`);
        await queryRunner.query(`CREATE TYPE "public"."thread_messages_source_enum" AS ENUM('operator', 'atlas', 'system', 'untrusted')`);
        await queryRunner.query(`ALTER TABLE "thread_messages" ALTER COLUMN "source" TYPE "public"."thread_messages_source_enum" USING "source"::"public"."thread_messages_source_enum"`);

        // inbound_messages.source: same collapse.
        await queryRunner.query(`ALTER TABLE "inbound_messages" ALTER COLUMN "source" TYPE text USING "source"::text`);
        await queryRunner.query(`UPDATE "inbound_messages" SET "source" = 'system' WHERE "source" LIKE 'system\\_%'`);
        await queryRunner.query(`DROP TYPE "public"."inbound_messages_source_enum"`);
        await queryRunner.query(`CREATE TYPE "public"."inbound_messages_source_enum" AS ENUM('operator', 'atlas', 'system', 'untrusted')`);
        await queryRunner.query(`ALTER TABLE "inbound_messages" ALTER COLUMN "source" TYPE "public"."inbound_messages_source_enum" USING "source"::"public"."inbound_messages_source_enum"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Best-effort rollback: restores the old 8-value enums (system → system_shared) and the author column.
        await queryRunner.query(`ALTER TABLE "inbound_messages" ALTER COLUMN "source" TYPE text USING "source"::text`);
        await queryRunner.query(`DROP TYPE "public"."inbound_messages_source_enum"`);
        await queryRunner.query(`CREATE TYPE "public"."inbound_messages_source_enum" AS ENUM('operator', 'atlas', 'system_operator', 'system_shared', 'system_event', 'system_notice', 'system_reminder', 'untrusted')`);
        await queryRunner.query(`UPDATE "inbound_messages" SET "source" = 'system_shared' WHERE "source" = 'system'`);
        await queryRunner.query(`ALTER TABLE "inbound_messages" ALTER COLUMN "source" TYPE "public"."inbound_messages_source_enum" USING "source"::"public"."inbound_messages_source_enum"`);
        await queryRunner.query(`ALTER TABLE "inbound_messages" ADD "author" text NOT NULL DEFAULT ''`);

        await queryRunner.query(`ALTER TABLE "thread_messages" ALTER COLUMN "source" TYPE text USING "source"::text`);
        await queryRunner.query(`UPDATE "thread_messages" SET "source" = 'system_operator' WHERE "source" = 'system' AND "audience" = 'operator_only'`);
        await queryRunner.query(`UPDATE "thread_messages" SET "source" = 'system_shared' WHERE "source" = 'system'`);
        await queryRunner.query(`DROP TYPE "public"."thread_messages_source_enum"`);
        await queryRunner.query(`CREATE TYPE "public"."thread_messages_source_enum" AS ENUM('operator', 'atlas', 'system_operator', 'system_shared', 'system_event', 'system_notice', 'system_reminder', 'untrusted')`);
        await queryRunner.query(`ALTER TABLE "thread_messages" ALTER COLUMN "source" TYPE "public"."thread_messages_source_enum" USING "source"::"public"."thread_messages_source_enum"`);
        await queryRunner.query(`ALTER TABLE "thread_messages" DROP COLUMN "audience"`);
        await queryRunner.query(`DROP TYPE "public"."thread_messages_audience_enum"`);
    }

}
