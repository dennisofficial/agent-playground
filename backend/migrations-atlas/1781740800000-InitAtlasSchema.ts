import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Initial Atlas v2 schema — every `atlas_*` table on the SAME Postgres + pgvector as v1, on Atlas's
 * OWN datasource (`cli/atlas-data-source.ts`, history in `atlas_migrations`). HAND-WRITTEN, matching
 * the house convention for the v1 init migration: the pgvector extension, the `vector(1536)` column,
 * and the HNSW index are not reliably auto-generated, and a brand-new datasource has no prior
 * snapshot to diff against — so a clearly-documented hand-written initial migration is the right call
 * here (the generator workflow takes over from migration #2). Mirrors
 * `src/atlas/persistence/entities/*` exactly; constraint/index names follow `CustomNamingStrategy`
 * (pk_*, uq_*, fk_*, idx_*).
 */
export class InitAtlasSchema1781740800000 implements MigrationInterface {
  name = 'InitAtlasSchema1781740800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // pgvector for atlas_memory (no-op if v1 already enabled it on this DB).
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector`);

    // ─── atlas_teams (tenant registry) ─────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "atlas_teams" (
        "team_id"    text NOT NULL,
        "team_name"  text NOT NULL,
        "status"     text NOT NULL DEFAULT 'active',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_atlas_teams" PRIMARY KEY ("team_id")
      )
    `);

    // ─── atlas_projects (repo registry; composite PK) ──────────────────────
    await queryRunner.query(`
      CREATE TABLE "atlas_projects" (
        "team_id"        text NOT NULL,
        "project_id"     text NOT NULL,
        "display_name"   text NOT NULL,
        "description"    text,
        "git_url"        text NOT NULL,
        "default_branch" text NOT NULL DEFAULT 'main',
        "token_name"     text,
        "created_at"     timestamptz NOT NULL DEFAULT now(),
        "updated_at"     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_atlas_projects" PRIMARY KEY ("team_id", "project_id"),
        CONSTRAINT "fk_atlas_projects_team_id_atlas_teams"
          FOREIGN KEY ("team_id") REFERENCES "atlas_teams" ("team_id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_atlas_projects_team_id" ON "atlas_projects" ("team_id")`);

    // ─── atlas_channels (1:1 per project) ──────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "atlas_channels" (
        "id"                  uuid NOT NULL DEFAULT gen_random_uuid(),
        "team_id"             text NOT NULL,
        "project_id"          text NOT NULL,
        "surface_channel_ref" text,
        "display_name"        text NOT NULL,
        "created_at"          timestamptz NOT NULL DEFAULT now(),
        "updated_at"          timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_atlas_channels" PRIMARY KEY ("id"),
        CONSTRAINT "uq_atlas_channels_team_id_project_id" UNIQUE ("team_id", "project_id"),
        CONSTRAINT "fk_atlas_channels_team_id_project_id_atlas_projects"
          FOREIGN KEY ("team_id", "project_id")
          REFERENCES "atlas_projects" ("team_id", "project_id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_atlas_channels_team_id" ON "atlas_channels" ("team_id")`);

    // ─── atlas_threads ─────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "atlas_threads" (
        "id"                 uuid NOT NULL DEFAULT gen_random_uuid(),
        "team_id"            text NOT NULL,
        "project_id"         text NOT NULL,
        "origin"             text NOT NULL,
        "surface_thread_ref" text,
        "title"              text,
        "created_at"         timestamptz NOT NULL DEFAULT now(),
        "updated_at"         timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_atlas_threads" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_atlas_threads_team_id_project_id" ON "atlas_threads" ("team_id", "project_id")`,
    );

    // ─── atlas_messages (partitioned-by-thread chat log) ───────────────────
    await queryRunner.query(`
      CREATE TABLE "atlas_messages" (
        "id"            uuid NOT NULL DEFAULT gen_random_uuid(),
        "thread_id"     uuid NOT NULL,
        "author"        text NOT NULL,
        "author_id"     text NOT NULL,
        "author_bot_id" text,
        "text"          text NOT NULL,
        "created_at"    timestamptz NOT NULL DEFAULT now(),
        "updated_at"    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_atlas_messages" PRIMARY KEY ("id"),
        CONSTRAINT "fk_atlas_messages_thread_id_atlas_threads"
          FOREIGN KEY ("thread_id") REFERENCES "atlas_threads" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_atlas_messages_thread_id_created_at" ON "atlas_messages" ("thread_id", "created_at")`,
    );

    // ─── atlas_stimuli (chat/event subtypes; event dedup) ──────────────────
    await queryRunner.query(`
      CREATE TABLE "atlas_stimuli" (
        "id"          uuid NOT NULL DEFAULT gen_random_uuid(),
        "team_id"     text NOT NULL,
        "project_id"  text NOT NULL,
        "kind"        text NOT NULL,
        "trust"       text NOT NULL,
        "body"        text NOT NULL,
        "thread_id"   uuid,
        "author_id"   text,
        "reply_route" jsonb,
        "source"      text,
        "dedupe_key"  text,
        "severity"    text,
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "updated_at"  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_atlas_stimuli" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_atlas_stimuli_team_id_project_id" ON "atlas_stimuli" ("team_id", "project_id")`,
    );
    // Event dedup: at most one event row per (team, project, source, dedupe_key). Partial — chat
    // stimuli carry no dedupe_key and are exempt.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_atlas_stimuli_team_id_project_id_source_dedupe_key"
        ON "atlas_stimuli" ("team_id", "project_id", "source", "dedupe_key")
        WHERE "kind" = 'event'
    `);

    // ─── atlas_decision_records (the locked upfront record) ─────────────────
    await queryRunner.query(`
      CREATE TABLE "atlas_decision_records" (
        "id"             uuid NOT NULL DEFAULT gen_random_uuid(),
        "team_id"        text NOT NULL,
        "project_id"     text NOT NULL,
        "job_id"         uuid NOT NULL,
        "status"         text NOT NULL DEFAULT 'draft',
        "overview"       text NOT NULL,
        "decisions"      jsonb NOT NULL DEFAULT '[]'::jsonb,
        "section_briefs" text[] NOT NULL DEFAULT '{}',
        "approved_by"    text,
        "approved_at"    timestamptz,
        "created_at"     timestamptz NOT NULL DEFAULT now(),
        "updated_at"     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_atlas_decision_records" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_atlas_decision_records_team_id_project_id" ON "atlas_decision_records" ("team_id", "project_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_atlas_decision_records_job_id" ON "atlas_decision_records" ("job_id")`,
    );

    // ─── atlas_jobs (ordered-sections unit of work) ────────────────────────
    await queryRunner.query(`
      CREATE TABLE "atlas_jobs" (
        "id"                 uuid NOT NULL DEFAULT gen_random_uuid(),
        "team_id"            text NOT NULL,
        "project_id"         text NOT NULL,
        "thread_id"          uuid NOT NULL,
        "kind"               text NOT NULL DEFAULT 'feature',
        "status"             text NOT NULL DEFAULT 'scoping',
        "title"              text NOT NULL,
        "decision_record_id" uuid,
        "feature_branch"     text,
        "pr_url"             text,
        "created_at"         timestamptz NOT NULL DEFAULT now(),
        "updated_at"         timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_atlas_jobs" PRIMARY KEY ("id"),
        CONSTRAINT "fk_atlas_jobs_thread_id_atlas_threads"
          FOREIGN KEY ("thread_id") REFERENCES "atlas_threads" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_atlas_jobs_team_id_project_id" ON "atlas_jobs" ("team_id", "project_id")`,
    );
    await queryRunner.query(`CREATE INDEX "idx_atlas_jobs_team_id_status" ON "atlas_jobs" ("team_id", "status")`);

    // ─── atlas_sections (a job's ordered slices) ───────────────────────────
    await queryRunner.query(`
      CREATE TABLE "atlas_sections" (
        "id"          uuid NOT NULL DEFAULT gen_random_uuid(),
        "job_id"      uuid NOT NULL,
        "team_id"     text NOT NULL,
        "ordinal"     int NOT NULL,
        "brief"       text NOT NULL,
        "plan"        text,
        "handoff_in"  text,
        "handoff_out" text,
        "status"      text NOT NULL DEFAULT 'pending',
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "updated_at"  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_atlas_sections" PRIMARY KEY ("id"),
        CONSTRAINT "uq_atlas_sections_job_id_ordinal" UNIQUE ("job_id", "ordinal"),
        CONSTRAINT "fk_atlas_sections_job_id_atlas_jobs"
          FOREIGN KEY ("job_id") REFERENCES "atlas_jobs" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_atlas_sections_job_id" ON "atlas_sections" ("job_id")`);

    // ─── atlas_phases (explicit resumable step state) ──────────────────────
    await queryRunner.query(`
      CREATE TABLE "atlas_phases" (
        "id"          uuid NOT NULL DEFAULT gen_random_uuid(),
        "section_id"  uuid NOT NULL,
        "job_id"      uuid NOT NULL,
        "team_id"     text NOT NULL,
        "ordinal"     int NOT NULL,
        "title"       text,
        "brief"       text NOT NULL,
        "step"        text NOT NULL DEFAULT 'build',
        "status"      text NOT NULL DEFAULT 'pending',
        "session_id"  text,
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "updated_at"  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_atlas_phases" PRIMARY KEY ("id"),
        CONSTRAINT "uq_atlas_phases_section_id_ordinal" UNIQUE ("section_id", "ordinal"),
        CONSTRAINT "fk_atlas_phases_section_id_atlas_sections"
          FOREIGN KEY ("section_id") REFERENCES "atlas_sections" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_atlas_phases_section_id" ON "atlas_phases" ("section_id")`);
    await queryRunner.query(`CREATE INDEX "idx_atlas_phases_job_id" ON "atlas_phases" ("job_id")`);

    // ─── atlas_memory (own pgvector) ───────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "atlas_memory" (
        "id"          SERIAL NOT NULL,
        "fact"        text NOT NULL,
        "embedding"   vector(1536) NOT NULL,
        "team_id"     text,
        "scope"       text NOT NULL,
        "asserted_by" text,
        "confidence"  real NOT NULL DEFAULT 1.0,
        "embed_model" text,
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "updated_at"  timestamptz NOT NULL DEFAULT now(),
        "deleted_at"  timestamptz,
        CONSTRAINT "pk_atlas_memory" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_atlas_memory_scope" ON "atlas_memory" ("scope")`);
    await queryRunner.query(
      `CREATE INDEX "idx_atlas_memory_team_id_scope" ON "atlas_memory" ("team_id", "scope")`,
    );
    // HNSW cosine index for semantic recall (embedding <=> query).
    await queryRunner.query(
      `CREATE INDEX "idx_atlas_memory_embedding_hnsw" ON "atlas_memory" USING hnsw ("embedding" vector_cosine_ops)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop in FK-dependency order (children first).
    await queryRunner.query(`DROP TABLE "atlas_memory"`);
    await queryRunner.query(`DROP TABLE "atlas_phases"`);
    await queryRunner.query(`DROP TABLE "atlas_sections"`);
    await queryRunner.query(`DROP TABLE "atlas_jobs"`);
    await queryRunner.query(`DROP TABLE "atlas_decision_records"`);
    await queryRunner.query(`DROP TABLE "atlas_stimuli"`);
    await queryRunner.query(`DROP TABLE "atlas_messages"`);
    await queryRunner.query(`DROP TABLE "atlas_threads"`);
    await queryRunner.query(`DROP TABLE "atlas_channels"`);
    await queryRunner.query(`DROP TABLE "atlas_projects"`);
    await queryRunner.query(`DROP TABLE "atlas_teams"`);
    // The pgvector extension is shared with v1 — DO NOT drop it here.
  }
}
