import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSessionNotes1781393663936 implements MigrationInterface {
    name = 'AddSessionNotes1781393663936'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "compaction_summaries" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" SERIAL NOT NULL, "thread" text NOT NULL, "version" integer NOT NULL, "covered_up_to" integer NOT NULL, "summary" text NOT NULL, CONSTRAINT "pk_compaction_summaries" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_compaction_summaries_thread" ON "compaction_summaries" ("thread") `);
        await queryRunner.query(`CREATE TABLE "session_notes" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" SERIAL NOT NULL, "team_id" text NOT NULL, "owner_bot" text NOT NULL, "channel_id" text NOT NULL, "project" text NOT NULL, "kind" text NOT NULL, "body" text NOT NULL, "status" text NOT NULL DEFAULT 'open', CONSTRAINT "pk_session_notes" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_session_notes_team_id_owner_bot_channel_id_status" ON "session_notes" ("team_id", "owner_bot", "channel_id", "status") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_session_notes_team_id_owner_bot_channel_id_status"`);
        await queryRunner.query(`DROP TABLE "session_notes"`);
        await queryRunner.query(`DROP INDEX "public"."idx_compaction_summaries_thread"`);
        await queryRunner.query(`DROP TABLE "compaction_summaries"`);
    }

}
