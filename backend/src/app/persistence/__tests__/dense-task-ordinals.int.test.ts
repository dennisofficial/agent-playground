/**
 * DenseTaskOrdinals migration (1784138169645) — the #261 → per-stage-#N backfill.
 *
 * Proves (against live Postgres) that the data-only migration renumbers existing `tasks.ordinal` to a
 * DENSE per-stage sequence (1,2,3 — independently per stage, so both stages restart at 1) and remaps the
 * `blocked_by` arrays #261 stored in uuid space onto the target rows' new #N, dropping dangling uuids.
 *
 * Integration: real Postgres (atlas_test schema). Seeds org/repo/job + two stages + gap-ordinal tasks with
 * uuid `blocked_by`, runs the migration's `up()`, and asserts the renumbered ordinals + remapped edges.
 */

import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomNamingStrategy } from '../../../_lib/database/custom-naming.strategy';
import { DB_CONNECTION } from '../database.module';
import { DENSE_TASK_ORDINALS_UP } from '../dense-task-ordinals.sql';
import { ENTITIES } from '../entities';

const ORG_ID = '21111111-1111-4111-8111-111111111111';
const BASE_BRANCH = 'main';

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

describe('DenseTaskOrdinals migration (live Postgres)', () => {
  let mod: TestingModule;
  let ds: DataSource;
  let repoId: string;
  let jobId: string;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [TypeOrmModule.forRoot(dbOpts())],
    }).compile();
    ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));

    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, $2, $3, 'active')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [ORG_ID, 'Dense Ordinals Org', 'dense-ordinals-org'],
    );
    const repoRows = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
       VALUES ($1, 'dense-ordinals-repo', 'Dense Ordinals Repo', 'https://github.com/x/y.git', $2, NULL, true)
       ON CONFLICT (org_id, slug) DO UPDATE SET git_url = EXCLUDED.git_url RETURNING id`,
      [ORG_ID, BASE_BRANCH],
    );
    repoId = repoRows[0].id;
  });

  afterAll(async () => {
    await mod?.close();
  });

  beforeEach(async () => {
    await ds.query('TRUNCATE tasks, threads, thread_groups, jobs RESTART IDENTITY CASCADE');
    const jobRows = await ds.query(
      `INSERT INTO jobs (org_id, repo_id, origin, title, kind, status, base_branch)
       VALUES ($1, $2, 'control', 'dense ordinals', 'feature', 'running', $3) RETURNING id`,
      [ORG_ID, repoId, BASE_BRANCH],
    );
    jobId = jobRows[0].id;
  });

  async function seedThreadGroup(ordinal: number): Promise<string> {
    const rows = await ds.query(
      `INSERT INTO thread_groups (job_id, org_id, ordinal, kind, status)
       VALUES ($1, $2, $3, 'build', 'executing') RETURNING id`,
      [jobId, ORG_ID, ordinal],
    );
    return rows[0].id;
  }

  async function seedTask(input: {
    threadGroupId: string;
    ordinal: number;
    title: string;
    blockedBy?: string[];
  }): Promise<string> {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO tasks (id, thread_group_id, org_id, ordinal, title, status, blocked_by)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6::jsonb)`,
      [
        id,
        input.threadGroupId,
        ORG_ID,
        input.ordinal,
        input.title,
        JSON.stringify(input.blockedBy ?? []),
      ],
    );
    return id;
  }

  const readTasks = (threadGroupId: string) =>
    ds.query(
      `SELECT title, ordinal, blocked_by FROM tasks WHERE thread_group_id = $1 ORDER BY ordinal`,
      [threadGroupId],
    ) as Promise<Array<{ title: string; ordinal: number; blocked_by: string[] }>>;

  it('densely renumbers ordinals per thread group and remaps blocked_by uuid → #N (dropping dangling)', async () => {
    const groupA = await seedThreadGroup(10);
    const groupB = await seedThreadGroup(20);

    // Group A: gap-numbered 10/20/30 with uuid blocked_by edges + one dangling uuid.
    const aX = await seedTask({
      threadGroupId: groupA,
      ordinal: 10,
      title: 'A-X',
    });
    const aY = await seedTask({
      threadGroupId: groupA,
      ordinal: 20,
      title: 'A-Y',
      blockedBy: [aX],
    });
    await seedTask({
      threadGroupId: groupA,
      ordinal: 30,
      title: 'A-Z',
      blockedBy: [aY, randomUUID()], // second uuid is dangling — should be dropped
    });

    // Group B: independent thread group — its #N must restart at 1 (proves per-group partitioning).
    const bP = await seedTask({
      threadGroupId: groupB,
      ordinal: 10,
      title: 'B-P',
    });
    await seedTask({
      threadGroupId: groupB,
      ordinal: 20,
      title: 'B-Q',
      blockedBy: [bP],
    });

    // Run the migration's exact backfill statements (the same array its `up()` executes).
    for (const sql of DENSE_TASK_ORDINALS_UP) await ds.query(sql);

    expect(await readTasks(groupA)).toEqual([
      { title: 'A-X', ordinal: 1, blocked_by: [] },
      { title: 'A-Y', ordinal: 2, blocked_by: ['1'] }, // aX → #1
      { title: 'A-Z', ordinal: 3, blocked_by: ['2'] }, // aY → #2; dangling uuid dropped
    ]);
    expect(await readTasks(groupB)).toEqual([
      { title: 'B-P', ordinal: 1, blocked_by: [] },
      { title: 'B-Q', ordinal: 2, blocked_by: ['1'] }, // bP → #1, not #3 — edges never cross groups
    ]);
  });
});
