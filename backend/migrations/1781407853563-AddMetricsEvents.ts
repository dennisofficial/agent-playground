import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMetricsEvents1781407853563 implements MigrationInterface {
    name = 'AddMetricsEvents1781407853563'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "metrics_events" ("id" SERIAL NOT NULL, "team_id" text NOT NULL, "event_type" text NOT NULL, "ticket_id" text, "agent_id" text, "project_id" text, "session_id" text, "revision_number" integer, "duration_ms" integer, "time_to_approval_ms" integer, "reason" text, "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL, "payload" jsonb NOT NULL DEFAULT '{}'::jsonb, CONSTRAINT "pk_metrics_events" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_metrics_events_team_id_project_id_event_type_occurred_at" ON "metrics_events" ("team_id", "project_id", "event_type", "occurred_at") `);
        await queryRunner.query(`CREATE INDEX "idx_metrics_events_team_id_agent_id_event_type_occurred_at" ON "metrics_events" ("team_id", "agent_id", "event_type", "occurred_at") `);
        await queryRunner.query(`CREATE INDEX "idx_metrics_events_team_id_ticket_id_agent_id_revision_number" ON "metrics_events" ("team_id", "ticket_id", "agent_id", "revision_number") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_metrics_events_team_id_ticket_id_agent_id_revision_number"`);
        await queryRunner.query(`DROP INDEX "public"."idx_metrics_events_team_id_agent_id_event_type_occurred_at"`);
        await queryRunner.query(`DROP INDEX "public"."idx_metrics_events_team_id_project_id_event_type_occurred_at"`);
        await queryRunner.query(`DROP TABLE "metrics_events"`);
    }
}
