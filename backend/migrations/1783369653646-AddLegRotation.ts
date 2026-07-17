import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLegRotation1783369653646 implements MigrationInterface {
  name = 'AddLegRotation1783369653646';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "build_legs" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "org_id" uuid NOT NULL, "job_id" uuid NOT NULL, "thread_id" uuid NOT NULL, "ordinal" integer NOT NULL, "session_id" text, "status" text NOT NULL DEFAULT 'active', "handoff_md" text, "context_tokens_peak" integer, "ended_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "uq_build_legs_thread_id_ordinal" UNIQUE ("thread_id", "ordinal"), CONSTRAINT "pk_build_legs" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "idx_build_legs_job_id" ON "build_legs" ("job_id") `);
    await queryRunner.query(
      `CREATE INDEX "idx_build_legs_thread_id" ON "build_legs" ("thread_id") `,
    );
    await queryRunner.query(`ALTER TABLE "steps" ADD "rotating_session_id" text`);
    await queryRunner.query(`ALTER TABLE "steps" ADD "pending_leg_seed" text`);
    await queryRunner.query(`ALTER TABLE "steps" ADD "leg_ordinal" integer NOT NULL DEFAULT '1'`);
    await queryRunner.query(
      `ALTER TABLE "build_legs" ADD CONSTRAINT "fk_build_legs_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "build_legs" ADD CONSTRAINT "fk_build_legs_job_id_jobs" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "build_legs" ADD CONSTRAINT "fk_build_legs_thread_id_threads" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "build_legs" DROP CONSTRAINT "fk_build_legs_thread_id_threads"`,
    );
    await queryRunner.query(`ALTER TABLE "build_legs" DROP CONSTRAINT "fk_build_legs_job_id_jobs"`);
    await queryRunner.query(
      `ALTER TABLE "build_legs" DROP CONSTRAINT "fk_build_legs_org_id_organizations"`,
    );
    await queryRunner.query(`ALTER TABLE "steps" DROP COLUMN "leg_ordinal"`);
    await queryRunner.query(`ALTER TABLE "steps" DROP COLUMN "pending_leg_seed"`);
    await queryRunner.query(`ALTER TABLE "steps" DROP COLUMN "rotating_session_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_build_legs_thread_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_build_legs_job_id"`);
    await queryRunner.query(`DROP TABLE "build_legs"`);
  }
}
