/**
 * LIVE proof for the unified `task_*` host-bridge tools — the EXACT path the deployed bridge runs when an
 * engine (Claude/Codex) calls a task tool: `makeTaskTools` handlers → the real {@link EntityTaskEventSink}
 * → the thread-group-owned `tasks` rows.
 *
 * Proves two things at once against real Postgres:
 *   - the model/UI-facing id is the short per-stage `#N` (the row's dense `ordinal`, `1`/`2`/…), NOT the
 *     row uuid #261 surfaced — so `task_create` returns `Task #1 created`, not `Task #<uuid> created`;
 *   - durability across a builder-leg rotation: a FRESH sink instance (a new session/leg — no in-memory
 *     cache carries over) still lists both rows and can `task_update` one BY THE #N `task_list` reported.
 *     That is the precise case the pre-#261 dual-id fold failed.
 *
 * Integration: real Postgres (atlas_test schema); seeds org/repo/job + a build thread group/thread via the
 * store's own CRUD (mirrors `driver-store.int.test.ts`), then drives the tools end-to-end.
 */

import { Test, type TestingModule } from '@nestjs/testing';
import {
  TypeOrmModule,
  getDataSourceToken,
  getRepositoryToken,
} from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomNamingStrategy } from '../../_lib/database/custom-naming.strategy';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  ENTITIES,
  JobEntity,
  ThreadGroupEntity,
  TaskEntity,
  ThreadEntity,
} from '../persistence/entities';
import { JobDependencyService } from '../job-deps';
import { DriverStoreService } from '../driver/driver-store.service';
import { EntityTaskEventSink } from './turn-harness.service';
import { makeTaskTools } from './task-tools';
import type { TaskScope } from './thread-registry';

const ORG_ID = '5a111111-1111-4111-8111-111111111111';
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

/** Parse the short `#N` out of the `Task #<id> created: <subject>` string task_create returns (the same
 *  regex the web live overlay uses). */
function createdId(result: unknown): string {
  // eslint-disable-next-line no-console -- surfaced in the captured live-verification log.
  console.log(`[task-tools.int] task_create -> ${String(result)}`);
  const m = /Task #([\w-]+) created/.exec(String(result));
  if (!m) throw new Error(`no id in task_create result: ${String(result)}`);
  return m[1];
}

describe('task_* host-bridge tools — per-stage #N CRUD (live Postgres)', () => {
  let mod: TestingModule;
  let ds: DataSource;
  let store: DriverStoreService;
  let jobs: Repository<JobEntity>;
  let threads: Repository<ThreadEntity>;
  let threadGroups: Repository<ThreadGroupEntity>;
  let tasks: Repository<TaskEntity>;
  let repoId: string;

  /** Build a NEW sink (fresh session — no in-memory state carries over) over the live repos. */
  const freshSink = () =>
    new EntityTaskEventSink(threads, threadGroups, tasks);

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(dbOpts()),
        TypeOrmModule.forFeature(ENTITIES, DB_CONNECTION),
      ],
      providers: [
        DriverStoreService,
        { provide: JobDependencyService, useValue: { blockersOf: async () => [] } },
      ],
    }).compile();

    store = mod.get(DriverStoreService);
    ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    jobs = mod.get(getRepositoryToken(JobEntity, DB_CONNECTION));
    threads = mod.get(getRepositoryToken(ThreadEntity, DB_CONNECTION));
    threadGroups = mod.get(getRepositoryToken(ThreadGroupEntity, DB_CONNECTION));
    tasks = mod.get(getRepositoryToken(TaskEntity, DB_CONNECTION));

    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, $2, $3, 'active')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [ORG_ID, 'Task Tools Org', 'task-tools-org'],
    );
    const repoRows = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
       VALUES ($1, 'task-tools-repo', 'Task Tools Repo', 'https://github.com/x/y.git', $2, NULL, true)
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
  });

  async function seedThreadScope(): Promise<{ threadGroupId: string; scope: TaskScope }> {
    const job = await jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'task tools durability',
        kind: 'feature',
        status: 'running',
        base_branch: BASE_BRANCH,
      }),
    );
    const threadGroup = await store.createThreadGroup({
      jobId: job.id,
      orgId: ORG_ID,
      kind: 'build',
      title: 'Backend',
    });
    const thread = await store.createThreadInThreadGroup({
      threadGroupId: threadGroup.id,
      jobId: job.id,
      orgId: ORG_ID,
      role: 'builder',
      brief: 'Backend — task list',
    });
    return { threadGroupId: threadGroup.id, scope: { kind: 'thread', id: thread.id } };
  }

  it('creates → lists (fresh session) → updates by the listed #N → gets → deletes, all in the per-stage #N id space', async () => {
    const { threadGroupId, scope } = await seedThreadScope();

    // (a) Two creates through one tool instance — the ids are the short per-stage #N, NOT a uuid.
    const tools = makeTaskTools(freshSink(), scope);
    const idA = createdId(await tools.task_create({ subject: 'A' }));
    const idB = createdId(await tools.task_create({ subject: 'B' }));
    expect(idA).toBe('1');
    expect(idB).toBe('2');

    const rows = await tasks.find({ where: { thread_group_id: threadGroupId } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.title).sort()).toEqual(['A', 'B']);
    // The surfaced #N is the row's ordinal; the uuid PK stays the internal identity.
    expect(rows.map((r) => r.ordinal).sort()).toEqual([1, 2]);

    // (b) A FRESH tool set on a FRESH sink — simulates a new session/leg after rotation. The read hits the
    //     durable rows, and the #N task_list reports is the SAME #N task_update keys on.
    const rotated = makeTaskTools(freshSink(), scope);
    const listed = String(await rotated.task_list({}));
    // eslint-disable-next-line no-console -- surfaced in the captured live-verification log.
    console.log(`[task-tools.int] task_list ->\n${listed}`);
    expect(listed).toBe('#1 [pending] A\n#2 [pending] B');

    const updateRes = await rotated.task_update({ taskId: idB, status: 'completed' });
    expect(updateRes).toEqual({ ok: true });

    const afterUpdate = String(
      await makeTaskTools(freshSink(), scope).task_list({}),
    );
    expect(afterUpdate).toBe('#1 [pending] A\n#2 [completed] B');

    // (c) task_get returns A's detail by its #N.
    const detail = String(await rotated.task_get({ taskId: idA }));
    expect(detail).toContain(`#${idA} [pending] A`);

    // (d) A delete removes the row — asserted directly against the table (by the row's ordinal, since #N is
    //     the ordinal, not the uuid PK), not just the tool's return.
    expect(await rotated.task_update({ taskId: idA, status: 'deleted' })).toEqual({
      ok: true,
    });
    expect(
      await tasks.findOne({
        where: { thread_group_id: threadGroupId, ordinal: Number(idA) },
      }),
    ).toBeNull();
    expect(await tasks.find({ where: { thread_group_id: threadGroupId } })).toHaveLength(1);
  });

  it('blocked_by edges are stored + rendered in #N space', async () => {
    const { threadGroupId, scope } = await seedThreadScope();
    const tools = makeTaskTools(freshSink(), scope);

    await tools.task_create({ subject: 'A' }); // #1
    const idB = createdId(
      await tools.task_create({ subject: 'B', addBlockedBy: ['1'] }),
    );
    expect(idB).toBe('2');

    // Stored as the #N string, not a uuid.
    const rowB = await tasks.findOne({
      where: { thread_group_id: threadGroupId, ordinal: 2 },
    });
    expect(rowB?.blocked_by).toEqual(['1']);

    expect(await makeTaskTools(freshSink(), scope).task_list({})).toBe(
      '#1 [pending] A\n#2 [pending] B (blocked by 1)',
    );
  });

  it('task_list on an empty thread group returns the exact "No tasks found." string', async () => {
    const { scope } = await seedThreadScope();
    expect(await makeTaskTools(freshSink(), scope).task_list({})).toBe(
      'No tasks found.',
    );
  });
});
