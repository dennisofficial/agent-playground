import { MigrationInterface, QueryRunner } from "typeorm";

export class RestoreDroppedUniqueIndexes1783600100000 implements MigrationInterface {
    name = 'RestoreDroppedUniqueIndexes1783600100000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "uq_threads_ticket_id" ON "jobs" ("ticket_id") WHERE "ticket_id" IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "uq_threads_job_parent_ordinal" ON "threads" ("job_id", "parent_thread_id", "ordinal") NULLS NOT DISTINCT`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."uq_threads_job_parent_ordinal"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."uq_threads_ticket_id"`);
    }
}
