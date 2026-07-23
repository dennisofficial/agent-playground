import { MigrationInterface, QueryRunner } from "typeorm";

export class ConsumptionModelAndActiveTurns1784771257024 implements MigrationInterface {
    name = 'ConsumptionModelAndActiveTurns1784771257024'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "active_turns" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "org_id" uuid NOT NULL, "job_id" uuid NOT NULL, "thread_id" uuid NOT NULL, "turn_id" uuid NOT NULL, CONSTRAINT "uq_active_turns_job_id" UNIQUE ("job_id"), CONSTRAINT "pk_active_turns" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_active_turns_org_id" ON "active_turns" ("org_id") `);
        await queryRunner.query(`ALTER TABLE "thread_messages" DROP COLUMN "author"`);
        await queryRunner.query(`DROP INDEX "public"."idx_inbound_messages_job_id_status"`);
        await queryRunner.query(`ALTER TYPE "public"."inbound_messages_status_enum" RENAME TO "inbound_messages_status_enum_old"`);
        await queryRunner.query(`CREATE TYPE "public"."inbound_messages_status_enum" AS ENUM('draft', 'pending', 'consumed', 'delivered')`);
        await queryRunner.query(`ALTER TABLE "inbound_messages" ALTER COLUMN "status" DROP DEFAULT`);
        await queryRunner.query(`ALTER TABLE "inbound_messages" ALTER COLUMN "status" TYPE "public"."inbound_messages_status_enum" USING "status"::"text"::"public"."inbound_messages_status_enum"`);
        await queryRunner.query(`ALTER TABLE "inbound_messages" ALTER COLUMN "status" SET DEFAULT 'pending'`);
        await queryRunner.query(`DROP TYPE "public"."inbound_messages_status_enum_old"`);
        await queryRunner.query(`CREATE INDEX "idx_inbound_messages_job_id_status" ON "inbound_messages" ("job_id", "status") `);
        await queryRunner.query(`ALTER TABLE "active_turns" ADD CONSTRAINT "fk_active_turns_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "active_turns" ADD CONSTRAINT "fk_active_turns_job_id_jobs" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "active_turns" ADD CONSTRAINT "fk_active_turns_thread_id_threads" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "active_turns" DROP CONSTRAINT "fk_active_turns_thread_id_threads"`);
        await queryRunner.query(`ALTER TABLE "active_turns" DROP CONSTRAINT "fk_active_turns_job_id_jobs"`);
        await queryRunner.query(`ALTER TABLE "active_turns" DROP CONSTRAINT "fk_active_turns_org_id_organizations"`);
        await queryRunner.query(`DROP INDEX "public"."idx_inbound_messages_job_id_status"`);
        await queryRunner.query(`CREATE TYPE "public"."inbound_messages_status_enum_old" AS ENUM('delivered', 'draft', 'pending')`);
        await queryRunner.query(`ALTER TABLE "inbound_messages" ALTER COLUMN "status" DROP DEFAULT`);
        await queryRunner.query(`ALTER TABLE "inbound_messages" ALTER COLUMN "status" TYPE "public"."inbound_messages_status_enum_old" USING "status"::"text"::"public"."inbound_messages_status_enum_old"`);
        await queryRunner.query(`ALTER TABLE "inbound_messages" ALTER COLUMN "status" SET DEFAULT 'pending'`);
        await queryRunner.query(`DROP TYPE "public"."inbound_messages_status_enum"`);
        await queryRunner.query(`ALTER TYPE "public"."inbound_messages_status_enum_old" RENAME TO "inbound_messages_status_enum"`);
        await queryRunner.query(`CREATE INDEX "idx_inbound_messages_job_id_status" ON "inbound_messages" ("job_id", "status") `);
        await queryRunner.query(`ALTER TABLE "thread_messages" ADD "author" text NOT NULL`);
        await queryRunner.query(`DROP INDEX "public"."idx_active_turns_org_id"`);
        await queryRunner.query(`DROP TABLE "active_turns"`);
    }

}
