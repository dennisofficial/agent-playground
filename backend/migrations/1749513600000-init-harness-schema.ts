import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Initial harness schema on Postgres + pgvector. Hand-written (the pgvector extension, the
 * `vector(1536)` column, and the HNSW index are not reliably auto-generated). Mirrors the entities in
 * `@workspace/shared/schemas` (facts/tasks/worklog). The board (tickets/plans/comments) is deferred —
 * it's being redesigned and will land with its own entities + migration.
 */
export class InitHarnessSchema1749513600000 implements MigrationInterface {
  name = 'InitHarnessSchema1749513600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector`);

    // ─── facts (semantic memory) ───────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "facts" (
        "id"             SERIAL PRIMARY KEY,
        "fact"           text NOT NULL,
        "embedding"      vector(1536) NOT NULL,
        "scope"          text NOT NULL,
        "asserted_by"    text,
        "source_surface" text,
        "confidence"     real NOT NULL DEFAULT 1.0,
        "embed_model"    text,
        "created_at"     timestamptz NOT NULL DEFAULT now(),
        "updated_at"     timestamptz NOT NULL DEFAULT now(),
        "deleted_at"     timestamptz
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_facts_scope" ON "facts" ("scope")`);
    // HNSW cosine index for semantic recall (embedding <=> query).
    await queryRunner.query(
      `CREATE INDEX "idx_facts_embedding_hnsw" ON "facts" USING hnsw ("embedding" vector_cosine_ops)`,
    );

    // ─── tasks (per-employee reminders / plate) ────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "tasks" (
        "id"          SERIAL PRIMARY KEY,
        "project"     text NOT NULL,
        "description" text NOT NULL,
        "norm"        text NOT NULL,
        "owner"       text NOT NULL DEFAULT '',
        "assignee"    text,
        "created_by"  text,
        "status"      text NOT NULL DEFAULT 'open',
        "source"      text,
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "updated_at"  timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_tasks_project_status_owner" ON "tasks" ("project", "status", "owner")`);
    // Open-dedup per (project, owner, norm).
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_tasks_project_owner_norm" ON "tasks" ("project", "owner", "norm") WHERE "status" = 'open'`,
    );

    // ─── worklog (episodic: completed work) ────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "worklog" (
        "id"           SERIAL PRIMARY KEY,
        "owner_bot"    text NOT NULL,
        "project"      text NOT NULL,
        "task"         text NOT NULL,
        "summary"      text NOT NULL,
        "completed_at" timestamptz NOT NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_worklog_project_owner_bot_completed_at" ON "worklog" ("project", "owner_bot", "completed_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "worklog"`);
    await queryRunner.query(`DROP TABLE "tasks"`);
    await queryRunner.query(`DROP TABLE "facts"`);
  }
}
