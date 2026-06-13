import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSessionNotes1781400000000 implements MigrationInterface {
    name = 'AddSessionNotes1781400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "session_notes" ("id" SERIAL NOT NULL, "team_id" text NOT NULL, "owner_bot" text NOT NULL, "channel_id" text NOT NULL, "project" text NOT NULL, "kind" text NOT NULL, "body" text NOT NULL, "status" text NOT NULL DEFAULT 'open', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "pk_session_notes" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_session_notes_scope_status" ON "session_notes" ("team_id", "owner_bot", "channel_id", "status") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_session_notes_scope_status"`);
        await queryRunner.query(`DROP TABLE "session_notes"`);
    }

}
