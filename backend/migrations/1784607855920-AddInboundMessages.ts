import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddInboundMessages1784607855920 implements MigrationInterface {
  name = 'AddInboundMessages1784607855920';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."inbound_messages_source_enum" AS ENUM('operator', 'atlas', 'system_operator', 'system_shared', 'system_event', 'system_notice', 'system_reminder', 'untrusted')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."inbound_messages_status_enum" AS ENUM('draft', 'pending', 'delivered')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."inbound_messages_priority_enum" AS ENUM('now', 'queued', 'later')`,
    );
    await queryRunner.query(
      `CREATE TABLE "inbound_messages" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "org_id" uuid NOT NULL, "job_id" uuid NOT NULL, "thread_id" uuid NOT NULL, "author_id" text NOT NULL, "author" text NOT NULL, "source" "public"."inbound_messages_source_enum" NOT NULL, "text" text NOT NULL, "payload" jsonb, "status" "public"."inbound_messages_status_enum" NOT NULL DEFAULT 'pending', "priority" "public"."inbound_messages_priority_enum" NOT NULL DEFAULT 'now', "delivered_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "pk_inbound_messages" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_inbound_messages_org_id" ON "inbound_messages" ("org_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_inbound_messages_job_id_status" ON "inbound_messages" ("job_id", "status") `,
    );
    await queryRunner.query(
      `ALTER TABLE "inbound_messages" ADD CONSTRAINT "fk_inbound_messages_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "inbound_messages" ADD CONSTRAINT "fk_inbound_messages_job_id_jobs" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "inbound_messages" ADD CONSTRAINT "fk_inbound_messages_thread_id_threads" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "activity"`);
    await queryRunner.query(`DROP TYPE "public"."jobs_activity_enum"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."jobs_activity_enum" AS ENUM('base_check', 'build', 'idle', 'master_review', 'plan_review', 'retrying', 'turn')`,
    );
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD "activity" "public"."jobs_activity_enum" NOT NULL DEFAULT 'idle'`,
    );
    await queryRunner.query(
      `ALTER TABLE "inbound_messages" DROP CONSTRAINT "fk_inbound_messages_thread_id_threads"`,
    );
    await queryRunner.query(
      `ALTER TABLE "inbound_messages" DROP CONSTRAINT "fk_inbound_messages_job_id_jobs"`,
    );
    await queryRunner.query(
      `ALTER TABLE "inbound_messages" DROP CONSTRAINT "fk_inbound_messages_org_id_organizations"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_inbound_messages_job_id_status"`);
    await queryRunner.query(`DROP INDEX "public"."idx_inbound_messages_org_id"`);
    await queryRunner.query(`DROP TABLE "inbound_messages"`);
    await queryRunner.query(`DROP TYPE "public"."inbound_messages_priority_enum"`);
    await queryRunner.query(`DROP TYPE "public"."inbound_messages_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."inbound_messages_source_enum"`);
  }
}
