
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomNamingStrategy } from '../../../_lib/database/custom-naming.strategy';
import { DB_CONNECTION } from '../database.module';
import { ENTITIES } from '../entities';

const ORG_ID = '2a111111-1111-4111-8111-111111111111';
const RESTORED_INDEXES = ['uq_threads_job_parent_ordinal', 'idx_memory_embedding_hnsw'] as const;
const DROPPED_TICKET_INDEXES = ['uq_threads_ticket_id', 'idx_tickets_embedding_hnsw'] as const;

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

async function insertThreadGroup(
  ds: DataSource,
  args: {
    jobId: string;
    ordinal: number;
    decisionRecordId?: string | null;
  },
): Promise<string> {
  const rows = await ds.query(
    `INSERT INTO thread_groups (job_id, org_id, ordinal, kind, decision_record_id)
     VALUES ($1, $2, $3, 'build', $4) RETURNING id`,
    [args.jobId, ORG_ID, args.ordinal, args.decisionRecordId ?? null],
  );
  return rows[0].id as string;
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

  it.each(DROPPED_TICKET_INDEXES)(
    'index %s no longer exists after the DropTickets migration',
    async (idx) => {
      const rows = await ds.query(`SELECT 1 FROM pg_indexes WHERE indexname = $1`, [idx]);
      expect(rows.length, `${idx} must not exist after the DropTickets migration`).toBe(0);
    },
  );

  it('the tickets table no longer exists after the DropTickets migration', async () => {
    const rows = await ds.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'tickets'`,
    );
    expect(rows.length, 'tickets table must not exist after the DropTickets migration').toBe(0);
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

    const threadGroupId = await insertThreadGroup(ds, { jobId, ordinal: 10 });

    const insertThread = () =>
      ds.query(
        `INSERT INTO threads (job_id, org_id, thread_group_id, role, ordinal, brief, parent_thread_id)
         VALUES ($1, $2, $3, 'builder', 10, 'first', NULL)`,
        [jobId, ORG_ID, threadGroupId],
      );

    await insertThread();
    await expect(insertThread()).rejects.toThrow();
  });

  it('uq_threads_job_parent_ordinal rejects duplicate root ordinals across different plan revisions', async () => {
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
    const recRows = await ds.query(
      `INSERT INTO decision_records (org_id, repo_id, job_id, overview)
       VALUES ($1, $2, $3, 'rev one'), ($1, $2, $3, 'rev two') RETURNING id`,
      [ORG_ID, repoId, jobId],
    );
    const [threadGroupA, threadGroupB] = await Promise.all([
      insertThreadGroup(ds, {
        jobId,
        ordinal: 10,
        decisionRecordId: recRows[0].id as string,
      }),
      insertThreadGroup(ds, {
        jobId,
        ordinal: 20,
        decisionRecordId: recRows[1].id as string,
      }),
    ]);
    const insertAt10 = (threadGroupId: string) =>
      ds.query(
        `INSERT INTO threads (job_id, org_id, thread_group_id, role, ordinal, brief, parent_thread_id)
         VALUES ($1, $2, $3, 'builder', 10, 'lane', NULL)`,
        [jobId, ORG_ID, threadGroupId],
      );
    await insertAt10(threadGroupA);
    await expect(insertAt10(threadGroupB)).rejects.toThrow();
  });
});
