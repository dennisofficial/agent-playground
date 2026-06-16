import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Single-voice migration: the per-employee Slack puppet identities are gone (only Atlas posts), so
 * drop the table that stored their tokens. Hand-written DROP — TypeORM's generator never emits drops
 * for tables whose entity has been removed (it leaves unmanaged tables untouched as a safety guard).
 */
export class DropSlackIdentities1781649780758 implements MigrationInterface {
    name = 'DropSlackIdentities1781649780758'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "slack_identities"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "slack_identities" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "bot_id" text NOT NULL, "token_ciphertext" text NOT NULL, "team_id" text NOT NULL, "slack_bot_user_id" text, CONSTRAINT "pk_slack_identities" PRIMARY KEY ("bot_id", "team_id"))`);
    }

}
