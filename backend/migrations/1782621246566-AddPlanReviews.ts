import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPlanReviews1782621246566 implements MigrationInterface {
  name = 'AddPlanReviews1782621246566';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "plan_reviews" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "thread_id" uuid NOT NULL, "org_id" uuid NOT NULL, "decision_record_id" uuid, "round" integer NOT NULL, "status" text NOT NULL DEFAULT 'running', "prompt" text NOT NULL, "findings" text, "completed_at" TIMESTAMP WITH TIME ZONE, "delivered_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "pk_plan_reviews" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_plan_reviews_status" ON "plan_reviews" ("status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_plan_reviews_thread_id_round" ON "plan_reviews" ("thread_id", "round") `,
    );
    await queryRunner.query(
      `ALTER TABLE "plan_reviews" ADD CONSTRAINT "fk_plan_reviews_thread_id_threads" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "plan_reviews" DROP CONSTRAINT "fk_plan_reviews_thread_id_threads"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_plan_reviews_thread_id_round"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_plan_reviews_status"`);
    await queryRunner.query(`DROP TABLE "plan_reviews"`);
  }
}
