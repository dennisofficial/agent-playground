import { MigrationInterface, QueryRunner } from 'typeorm';

export class RestoreDroppedIndexes1783601000000 implements MigrationInterface {
  name = 'RestoreDroppedIndexes1783601000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Restore the four indexes 1783597139527-HaltOutcome dropped as pure generator drift.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_threads_ticket_id" ON "jobs" ("ticket_id") WHERE ticket_id IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_threads_job_parent_ordinal" ON "threads" ("job_id", "parent_thread_id", "ordinal") NULLS NOT DISTINCT`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tickets_embedding_hnsw" ON "tickets" USING hnsw ("embedding" vector_cosine_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_memory_embedding_hnsw" ON "memory" USING hnsw ("embedding" vector_cosine_ops)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."idx_memory_embedding_hnsw"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."idx_tickets_embedding_hnsw"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."uq_threads_job_parent_ordinal"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."uq_threads_ticket_id"`,
    );
  }
}
