import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Collapse Atlas to the single web surface: drop the now-unused `atlas_threads.surface` column (added by
 * AddThreadSurface for the short-lived multi-surface dispatch) and the `atlas_slack_installations` table
 * (the deleted multi-workspace Slack adapter's per-workspace bot-token store). TypeORM's generator drops
 * the column but leaves the orphan table, so the DROP TABLE is added here; `down` re-creates both.
 */
export class CollapseToWebSurface1782146069871 implements MigrationInterface {
    name = 'CollapseToWebSurface1782146069871'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "atlas_threads" DROP COLUMN "surface"`);
        await queryRunner.query(`DROP TABLE "atlas_slack_installations"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "atlas_slack_installations" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "team_id" text NOT NULL, "bot_token_enc" text NOT NULL, "bot_user_id" text, "scopes" text, "team_name" text, "uninstalled_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "pk_atlas_slack_installations" PRIMARY KEY ("team_id"))`);
        await queryRunner.query(`ALTER TABLE "atlas_threads" ADD "surface" text NOT NULL DEFAULT 'slack'`);
    }
}
