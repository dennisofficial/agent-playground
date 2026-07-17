import { MigrationInterface, QueryRunner } from 'typeorm';

export class HaltOutcome1783597139527 implements MigrationInterface {
  name = 'HaltOutcome1783597139527';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_tickets_embedding_hnsw"`);
    await queryRunner.query(`DROP INDEX "public"."uq_threads_ticket_id"`);
    await queryRunner.query(`DROP INDEX "public"."uq_threads_job_parent_ordinal"`);
    await queryRunner.query(`DROP INDEX "public"."idx_memory_embedding_hnsw"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX "idx_memory_embedding_hnsw" ON "memory" ("embedding") `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_threads_job_parent_ordinal" ON "threads" ("job_id", "ordinal", "parent_thread_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_threads_ticket_id" ON "jobs" ("ticket_id") WHERE (ticket_id IS NOT NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_tickets_embedding_hnsw" ON "tickets" ("embedding") `,
    );
  }
}
