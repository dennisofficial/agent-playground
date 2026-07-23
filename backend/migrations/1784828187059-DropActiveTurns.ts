import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops `active_turns`. The live turn moved to Redis (`job:<id>:live` TTL pointer + the `/jobs/:id/turn/stream`
 * SSE), so the durable presence row is gone. Its entity was deleted, which makes TypeORM's schema differ blind
 * to the orphaned table (it only diffs entity-backed tables) — hence this hand-authored drop rather than a
 * generated one. `down()` recreates it verbatim from ConsumptionModelAndActiveTurns1784771257024.
 */
export class DropActiveTurns1784828187059 implements MigrationInterface {
  name = 'DropActiveTurns1784828187059';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // DROP TABLE removes the table's own index + FK constraints with it.
    await queryRunner.query(`DROP TABLE IF EXISTS "active_turns"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "active_turns" ("created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "org_id" uuid NOT NULL, "job_id" uuid NOT NULL, "thread_id" uuid NOT NULL, "turn_id" uuid NOT NULL, CONSTRAINT "uq_active_turns_job_id" UNIQUE ("job_id"), CONSTRAINT "pk_active_turns" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "idx_active_turns_org_id" ON "active_turns" ("org_id") `);
    await queryRunner.query(
      `ALTER TABLE "active_turns" ADD CONSTRAINT "fk_active_turns_org_id_organizations" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "active_turns" ADD CONSTRAINT "fk_active_turns_job_id_jobs" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "active_turns" ADD CONSTRAINT "fk_active_turns_thread_id_threads" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }
}
