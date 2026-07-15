/**
 * LIVE durability proof for the unified `task_*` host-bridge tools (Thread 1).
 *
 * Against real Postgres, this reproduces the exact bug the change fixes: after a builder-leg rotation the
 * OLD SDK-native `TaskList` read a per-session in-memory store that was empty post-rotation ("No tasks
 * found"), and the OLD dual-id fold couldn't `task_update` by an id that came from `task_list`. Here the
 * tools do direct CRUD on the stage-owned `tasks` rows in ONE durable uuid id space, so:
 *   (b) a FRESH sink instance (a new session/leg — no in-memory cache carries over) still lists both rows
 *       and can `task_update` one BY THE UUID `task_list` reported. That is the precise case the old
 *       design failed.
 *
 * Integration: real Postgres (atlas_test schema); seeds org/repo/job + a build stage/thread via the
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
  StageEntity,
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

/** Parse the durable uuid out of the `Task #<id> created: <subject>` string task_create returns. */
function createdId(result: unknown): string {
  const m = /Task #([\w-]+) created/.exec(String(result));
  if (!m) throw new Error(`no id in task_create result: ${String(result)}`);
  return m[1];
}

describe('task_* host-bridge tools — durable single-id-space CRUD (live Postgres)', () => {
  let mod: TestingModule;
  let ds: DataSource;
  let store: DriverStoreService;
  let jobs: Repository<JobEntity>;
  let threads: Repository<ThreadEntity>;
  let stages: Repository<StageEntity>;
  let tasks: Repository<TaskEntity>;
  let repoId: string;

  /** Build a NEW sink (fresh session — no in-memory state carries over) over the live repos. */
  const freshSink = () =>
    new EntityTaskEventSink(threads, stages, tasks);

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
    stages = mod.get(getRepositoryToken(StageEntity, DB_CONNECTION));
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
    await ds.query('TRUNCATE tasks, threads, stages, jobs RESTART IDENTITY CASCADE');
  });

  async function seedThreadScope(): Promise<{ stageId: string; scope: TaskScope }> {
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
    const stage = await store.createStage({
      jobId: job.id,
      orgId: ORG_ID,
      kind: 'build',
      title: 'Backend',
    });
    const thread = await store.createThreadInStage({
      stageId: stage.id,
      jobId: job.id,
      orgId: ORG_ID,
      role: 'builder',
      brief: 'Backend — task list',
    });
    return { stageId: stage.id, scope: { kind: 'thread', id: thread.id } };
  }

  it('creates → lists (fresh session) → updates by the listed uuid → gets → deletes, all in one durable id space', async () => {
    const { stageId, scope } = await seedThreadScope();

    // (a) Two creates through one tool instance.
    const tools = makeTaskTools(freshSink(), scope);
    const idA = createdId(await tools.task_create({ subject: 'A' }));
    const idB = createdId(await tools.task_create({ subject: 'B' }));

    const rows = await tasks.find({ where: { stage_id: stageId } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.title).sort()).toEqual(['A', 'B']);

    // (b) A FRESH tool set on a FRESH sink — simulates a new session/leg after rotation. The OLD dual-id
    //     design failed exactly here: task_list read an empty per-session store, and task_update by an id
    //     from task_list didn't match the session cache. Now the read hits the durable rows, and the uuid
    //     task_list reports is the SAME uuid task_update keys on.
    const rotated = makeTaskTools(freshSink(), scope);
    const listed = String(await rotated.task_list({}));
    expect(listed).toContain(`#${idA} [pending] A`);
    expect(listed).toContain(`#${idB} [pending] B`);

    const updateRes = await rotated.task_update({ taskId: idB, status: 'completed' });
    expect(updateRes).toEqual({ ok: true });

    const afterUpdate = String(
      await makeTaskTools(freshSink(), scope).task_list({}),
    );
    expect(afterUpdate).toContain(`#${idB} [completed] B`);
    expect(afterUpdate).toContain(`#${idA} [pending] A`);

    // (c) task_get returns A's detail by its uuid.
    const detail = String(await rotated.task_get({ taskId: idA }));
    expect(detail).toContain(`#${idA} [pending] A`);

    // (d) A delete removes the row — asserted directly against the table, not just the tool's return.
    expect(await rotated.task_update({ taskId: idA, status: 'deleted' })).toEqual({
      ok: true,
    });
    expect(await tasks.findOne({ where: { id: idA } })).toBeNull();
    expect(await tasks.find({ where: { stage_id: stageId } })).toHaveLength(1);
  });

  it('task_list on an empty stage returns the exact "No tasks found." string', async () => {
    const { scope } = await seedThreadScope();
    expect(await makeTaskTools(freshSink(), scope).task_list({})).toBe(
      'No tasks found.',
    );
  });
});
