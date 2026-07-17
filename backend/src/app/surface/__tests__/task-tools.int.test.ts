
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomNamingStrategy } from '../../../_lib/database/custom-naming.strategy';
import { DriverStoreService } from '../../driver/driver-store.service';
import { JobDependencyService } from '../../job-deps';
import { DB_CONNECTION } from '../../persistence/database.module';
import {
  ENTITIES,
  JobEntity,
  TaskEntity,
  ThreadEntity,
  ThreadGroupEntity,
} from '../../persistence/entities';
import { StimulusStoreService } from '../../stimulus/stimulus-store.service';
import { makeTaskTools } from '../task-tools';
import type { TaskScope } from '../thread-registry';
import { EntityTaskEventSink } from '../turn-harness.service';

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

function createdId(result: unknown): string {
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

  const freshSink = () => new EntityTaskEventSink(threads, threadGroups, tasks);

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [TypeOrmModule.forRoot(dbOpts()), TypeOrmModule.forFeature(ENTITIES, DB_CONNECTION)],
      providers: [
        DriverStoreService,
        {
          provide: JobDependencyService,
          useValue: { blockersOf: async () => [] },
        },
        {
          provide: StimulusStoreService,
          useValue: { pendingBlockedPreview: async () => null },
        },
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

  async function seedThreadScope(): Promise<{
    threadGroupId: string;
    scope: TaskScope;
  }> {
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
    return {
      threadGroupId: threadGroup.id,
      scope: { kind: 'thread', id: thread.id },
    };
  }

  it('creates → lists (fresh session) → updates by the listed #N → gets → deletes, all in the per-stage #N id space', async () => {
    const { threadGroupId, scope } = await seedThreadScope();

    const tools = makeTaskTools(freshSink(), scope);
    const idA = createdId(await tools.task_create({ subject: 'A' }));
    const idB = createdId(await tools.task_create({ subject: 'B' }));
    expect(idA).toBe('1');
    expect(idB).toBe('2');

    const rows = await tasks.find({
      where: { thread_group_id: threadGroupId },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.title).sort()).toEqual(['A', 'B']);
    expect(rows.map((r) => r.ordinal).sort()).toEqual([1, 2]);

    const rotated = makeTaskTools(freshSink(), scope);
    const listed = String(await rotated.task_list({}));
    console.log(`[task-tools.int] task_list ->\n${listed}`);
    expect(listed).toBe('#1 [pending] A\n#2 [pending] B');

    const updateRes = await rotated.task_update({
      taskId: idB,
      status: 'completed',
    });
    expect(updateRes).toEqual({ ok: true });

    const afterUpdate = String(await makeTaskTools(freshSink(), scope).task_list({}));
    expect(afterUpdate).toBe('#1 [pending] A\n#2 [completed] B');

    const detail = String(await rotated.task_get({ taskId: idA }));
    expect(detail).toContain(`#${idA} [pending] A`);

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
    const idB = createdId(await tools.task_create({ subject: 'B', addBlockedBy: ['1'] }));
    expect(idB).toBe('2');

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
    expect(await makeTaskTools(freshSink(), scope).task_list({})).toBe('No tasks found.');
  });
});
