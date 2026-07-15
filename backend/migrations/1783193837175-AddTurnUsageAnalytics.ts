import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTurnUsageAnalytics1783193837175 implements MigrationInterface {
  name = 'AddTurnUsageAnalytics1783193837175';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "turn_stats" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "turn_id" uuid, "org_id" uuid NOT NULL, "job_id" uuid NOT NULL, "thread_id" uuid, "step_id" uuid, "lane" text NOT NULL, "kind" text NOT NULL, "engine" text NOT NULL, "model" text, "input_tokens" bigint NOT NULL DEFAULT '0', "output_tokens" bigint NOT NULL DEFAULT '0', "cache_read_tokens" bigint NOT NULL DEFAULT '0', "cache_write_tokens" bigint NOT NULL DEFAULT '0', "cost_usd" numeric, "context_tokens" integer, "context_limit" integer, "tags" jsonb, "raw" jsonb, CONSTRAINT "pk_turn_stats" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_turn_stats_thread_id" ON "turn_stats" ("thread_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_turn_stats_org_id" ON "turn_stats" ("org_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_turn_stats_job_id" ON "turn_stats" ("job_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "turn_model_usage" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "turn_stats_id" uuid NOT NULL, "model" text NOT NULL, "org_id" uuid NOT NULL, "job_id" uuid NOT NULL, "input_tokens" bigint NOT NULL DEFAULT '0', "output_tokens" bigint NOT NULL DEFAULT '0', "cache_read_tokens" bigint NOT NULL DEFAULT '0', "cache_write_tokens" bigint NOT NULL DEFAULT '0', "cost_usd" numeric NOT NULL DEFAULT '0', "web_search_requests" integer NOT NULL DEFAULT '0', CONSTRAINT "pk_turn_model_usage" PRIMARY KEY ("turn_stats_id", "model"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_turn_model_usage_org_id" ON "turn_model_usage" ("org_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_turn_model_usage_job_id" ON "turn_model_usage" ("job_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "turn_stats" ADD CONSTRAINT "fk_turn_stats_job_id_jobs" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "turn_model_usage" ADD CONSTRAINT "fk_turn_model_usage_turn_stats_id_turn_stats" FOREIGN KEY ("turn_stats_id") REFERENCES "turn_stats"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "turn_model_usage" DROP CONSTRAINT "fk_turn_model_usage_turn_stats_id_turn_stats"`,
    );
    await queryRunner.query(
      `ALTER TABLE "turn_stats" DROP CONSTRAINT "fk_turn_stats_job_id_jobs"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_turn_model_usage_job_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_turn_model_usage_org_id"`,
    );
    await queryRunner.query(`DROP TABLE "turn_model_usage"`);
    await queryRunner.query(`DROP INDEX "public"."idx_turn_stats_job_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_turn_stats_org_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_turn_stats_thread_id"`);
    await queryRunner.query(`DROP TABLE "turn_stats"`);
  }
}
