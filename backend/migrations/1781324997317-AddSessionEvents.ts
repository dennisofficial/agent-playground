import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSessionEvents1781324997317 implements MigrationInterface {
    name = 'AddSessionEvents1781324997317'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "session_events" ("id" BIGSERIAL NOT NULL, "session_id" text NOT NULL, "kind" text NOT NULL, "text" text, "name" text, "detail" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "pk_session_events" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_session_events_session_id" ON "session_events" ("session_id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_session_events_session_id"`);
        await queryRunner.query(`DROP TABLE "session_events"`);
    }

}
