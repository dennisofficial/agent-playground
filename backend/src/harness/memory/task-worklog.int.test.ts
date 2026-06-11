import {
  ENTITIES,
  Task as TaskEntity,
  Worklog as WorklogEntity,
} from '@workspace/shared/schemas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { TaskStore } from './task-store';
import { WorklogStore } from './worklog-store';

function makeDataSource(): DataSource {
  return new DataSource({
    type: 'postgres',
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    username: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
    entities: ENTITIES,
    synchronize: false,
  });
}

describe('TaskStore + WorklogStore (live Postgres)', () => {
  let ds: DataSource;
  let tasks: TaskStore;
  let worklog: WorklogStore;

  beforeAll(async () => {
    ds = makeDataSource();
    await ds.initialize();
    tasks = new TaskStore(ds.getRepository(TaskEntity));
    worklog = new WorklogStore(ds.getRepository(WorklogEntity));
  });
  afterAll(async () => {
    await ds?.destroy();
  });
  beforeEach(async () => {
    await ds.query('TRUNCATE tasks RESTART IDENTITY');
    await ds.query('TRUNCATE worklog RESTART IDENTITY');
  });

  it('adds a reminder and dedups an identical open one on the same plate', async () => {
    const a = await tasks.addTask({
      team: 'T1', project: 'p',
      description: 'Wire the   hooks',
      owner: 'alex',
    });
    expect(a).toBeDefined();
    // Same plate + normalized description → no-op via the partial unique index.
    const dup = await tasks.addTask({
      team: 'T1', project: 'p',
      description: 'wire the hooks',
      owner: 'alex',
    });
    expect(dup).toBeUndefined();
    // Different owner → not a dup.
    const other = await tasks.addTask({
      team: 'T1', project: 'p',
      description: 'Wire the hooks',
      owner: 'riley',
    });
    expect(other).toBeDefined();
    expect((await tasks.openTasks('T1', 'p')).length).toBe(2);
  });

  it('re-adding is allowed once the original is no longer open', async () => {
    const a = await tasks.addTask({
      team: 'T1', project: 'p',
      description: 'task',
      owner: 'alex',
    });
    expect(await tasks.completeTask('T1', 'p', a!.id)).toBe(true);
    const again = await tasks.addTask({
      team: 'T1', project: 'p',
      description: 'task',
      owner: 'alex',
    });
    expect(again).toBeDefined(); // partial index only covers status='open'
  });

  it('remindersForBot returns owned + raised; project-scopes completion', async () => {
    await tasks.addTask({ team: 'T1', project: 'p', description: 'mine', owner: 'alex' });
    await tasks.addTask({
      team: 'T1', project: 'p',
      description: 'handoff',
      owner: 'riley',
      createdBy: 'alex',
    });
    await tasks.addTask({
      team: 'T1', project: 'p',
      description: 'theirs',
      owner: 'riley',
    });
    const forAlex = await tasks.remindersForBot('T1', 'p', 'alex');
    expect(forAlex.map((t) => t.description).sort()).toEqual([
      'handoff',
      'mine',
    ]);
    expect(await tasks.completeTask('T1', 'other-project', forAlex[0].id)).toBe(
      false,
    );
  });

  it('logs and reads recent work, scoped + newest-first', async () => {
    await worklog.logWork({
      ownerBot: 'alex',
      team: 'T1', project: 'p',
      task: 't1',
      summary: 's1',
    });
    await worklog.logWork({
      ownerBot: 'riley',
      team: 'T1', project: 'p',
      task: 't2',
      summary: 's2',
    });
    await worklog.logWork({
      ownerBot: 'alex',
      team: 'T1', project: 'q',
      task: 't3',
      summary: 's3',
    });
    const recent = await worklog.recentWork({ team: 'T1', project: 'p' });
    expect(recent.map((w) => w.task)).toEqual(['t2', 't1']); // newest first, project p only
    const alexOnly = await worklog.recentWork({
      team: 'T1', project: 'p',
      ownerBot: 'alex',
    });
    expect(alexOnly.map((w) => w.task)).toEqual(['t1']);
  });
});
