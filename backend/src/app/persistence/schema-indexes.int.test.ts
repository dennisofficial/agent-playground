/**
 * Schema-index regression net (live Postgres). The four indexes 1783597139527-HaltOutcome dropped as
 * pure generator drift — two integrity (`uq_threads_ticket_id`, `uq_threads_job_parent_ordinal`) and two
 * pgvector HNSW perf indexes (`idx_tickets_embedding_hnsw`, `idx_memory_embedding_hnsw`) — must exist
 * after the full migration chain (the RestoreDroppedIndexes heal migration recreates them). Fails loudly
 * in CI if a future migration drops one again. Also asserts uq_threads_job_parent_ordinal actually
 * rejects a duplicate `(job_id, parent_thread_id, ordinal)` — the NULLS NOT DISTINCT partial the
 * generator can't express, so only a functional check proves it is really there.
 */

import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomNamingStrategy } from '../../_lib/database/custom-naming.strategy';
import { DB_CONNECTION } from './database.module';
import { ENTITIES } from './entities';

const ORG_ID = '2a111111-1111-4111-8111-111111111111';
const RESTORED_INDEXES = [
  'uq_threads_ticket_id',
  'uq_threads_job_parent_ordinal',
  'idx_tickets_embedding_hnsw',
  'idx_memory_embedding_hnsw',
] as const;

function dbOpts() {
  return {
    name: DB_CONNECTION,
    type: 'postgres' as const,
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5433),
    username: process.env.POSTGRES_USER ?? 'postgres',
    password: process.env.POSTGRES_PASSWORD ?? 'postgres',
    database: process.env.POSTGRES_DB,
    entities: ENTITIES,
    namingStrategy: new CustomNamingStrategy(),
    synchronize: false,
    connectTimeoutMS: 10_000,
    ssl: false as const,
  };
}

async function purge(ds: DataSource): Promise<void> {
  await ds.query(`DELETE FROM jobs WHERE org_id = $1`, [ORG_ID]);
  await ds.query(`DELETE FROM repos WHERE org_id = $1`, [ORG_ID]);
  await ds.query(`DELETE FROM organizations WHERE id = $1`, [ORG_ID]);
}

describe('restored schema indexes (live Postgres)', () => {
  let mod: TestingModule;
  let ds: DataSource;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [TypeOrmModule.forRoot(dbOpts())],
    }).compile();
    ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    await purge(ds);
  });

  afterAll(async () => {
    if (ds) await purge(ds).catch(() => undefined);
    await mod?.close();
  });

  it.each(RESTORED_INDEXES)('index %s exists after the migration chain', async (idx) => {
    const rows = await ds.query(`SELECT 1 FROM pg_indexes WHERE indexname = $1`, [idx]);
    expect(rows.length, `${idx} must exist after the migration chain`).toBe(1);
  });

  it('uq_threads_job_parent_ordinal rejects a duplicate (job_id, parent_thread_id, ordinal)', async () => {
    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, $2, $3, 'active')
       ON CONFLICT (id) DO NOTHING`,
      [ORG_ID, 'Schema Index Org', 'schema-index-org'],
    );
    const repoRows = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
       VALUES ($1, 'schema-index-repo', 'Schema Index Repo', 'https://github.com/x/y.git', 'main', NULL, true)
       ON CONFLICT (org_id, slug) DO UPDATE SET git_url = EXCLUDED.git_url RETURNING id`,
      [ORG_ID],
    );
    const repoId = repoRows[0].id as string;
    const jobRows = await ds.query(
      `INSERT INTO jobs (org_id, repo_id, origin) VALUES ($1, $2, 'control') RETURNING id`,
      [ORG_ID, repoId],
    );
    const jobId = jobRows[0].id as string;

    const insertThread = () =>
      ds.query(
        `INSERT INTO threads (job_id, org_id, kind, ordinal, brief, parent_thread_id)
         VALUES ($1, $2, 'builder', 10, 'first', NULL)`,
        [jobId, ORG_ID],
      );

    await insertThread();
    // NULLS NOT DISTINCT: a second (job_id, NULL decision_record, NULL parent, ordinal) row must collide.
    await expect(insertThread()).rejects.toThrow();
  });

  it('uq_threads_job_parent_ordinal ALLOWS the same (parent, ordinal) across different plan revisions', async () => {
    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, $2, $3, 'active')
       ON CONFLICT (id) DO NOTHING`,
      [ORG_ID, 'Schema Index Org', 'schema-index-org'],
    );
    const repoRows = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
       VALUES ($1, 'schema-index-repo-rev', 'Schema Index Repo Rev', 'https://github.com/x/y.git', 'main', NULL, true)
       ON CONFLICT (org_id, slug) DO UPDATE SET git_url = EXCLUDED.git_url RETURNING id`,
      [ORG_ID],
    );
    const repoId = repoRows[0].id as string;
    const jobRows = await ds.query(
      `INSERT INTO jobs (org_id, repo_id, origin) VALUES ($1, $2, 'control') RETURNING id`,
      [ORG_ID, repoId],
    );
    const jobId = jobRows[0].id as string;
    // Two plan revisions (decision records) for the same job.
    const recRows = await ds.query(
      `INSERT INTO decision_records (org_id, repo_id, job_id, overview)
       VALUES ($1, $2, $3, 'rev one'), ($1, $2, $3, 'rev two') RETURNING id`,
      [ORG_ID, repoId, jobId],
    );
    const [recA, recB] = [recRows[0].id as string, recRows[1].id as string];
    const insertAt10 = (recordId: string) =>
      ds.query(
        `INSERT INTO threads (job_id, org_id, kind, ordinal, brief, parent_thread_id, decision_record_id)
         VALUES ($1, $2, 'builder', 10, 'lane', NULL, $3)`,
        [jobId, ORG_ID, recordId],
      );
    // Same (job, NULL parent, ordinal 10) but DIFFERENT decision_record_id → the revision column keeps them
    // distinct, so the second insert must NOT collide (this is what lets a re-propose preserve done lanes).
    await insertAt10(recA);
    await expect(insertAt10(recB)).resolves.toBeDefined();
  });
});
