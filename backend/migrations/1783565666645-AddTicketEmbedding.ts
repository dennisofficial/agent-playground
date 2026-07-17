import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTicketEmbedding1783565666645 implements MigrationInterface {
  name = 'AddTicketEmbedding1783565666645';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Semantic-dedup vector on tickets (1536-dim, text-embedding-3-small; mirrors `memory.embedding`).
    await queryRunner.query(`ALTER TABLE "tickets" ADD "embedding" vector(1536)`);
    // HAND-ADDED: pgvector HNSW cosine index (matches TicketService's `embedding <=> q` search);
    // the generator can't emit a vector index (and re-emits the memory/partial-unique DROP noise —
    // pruned from this migration). `vector` extension already exists from the Init migration.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tickets_embedding_hnsw" ON "tickets" USING hnsw ("embedding" vector_cosine_ops)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."idx_tickets_embedding_hnsw"`);
    await queryRunner.query(`ALTER TABLE "tickets" DROP COLUMN "embedding"`);
  }
}
