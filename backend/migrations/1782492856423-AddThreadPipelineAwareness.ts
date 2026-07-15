import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add the passive pipeline-milestone awareness buffer to `threads` — a durable per-thread record of build
 * milestones the thread brain hasn't been told about yet + the watermark of the last pipeline state
 * conveyed. Drained + prepended to the next operator turn (see `driver/pipeline-awareness.*`).
 *
 * Generator noise pruned by hand (per CLAUDE.md): the generator also emitted a DROP/CREATE of the pgvector
 * HNSW index (`idx_memory_embedding_hnsw`, which it never tracks) and a cosmetic restatement of the
 * `decision_records.decisions` default — both removed so this migration only adds the column.
 */
export class AddThreadPipelineAwareness1782492856423 implements MigrationInterface {
  name = 'AddThreadPipelineAwareness1782492856423';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "threads" ADD "pipeline_awareness" jsonb NOT NULL DEFAULT '{"markerQueue":[],"conveyedStateSig":null}'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "threads" DROP COLUMN "pipeline_awareness"`,
    );
  }
}
