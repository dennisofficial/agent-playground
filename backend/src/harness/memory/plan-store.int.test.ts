import {
  ENTITIES,
  TeamTaskPlan as TeamTaskPlanEntity,
} from '@workspace/shared/schemas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { PlanStore } from './plan-store';

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

describe('PlanStore (live Postgres)', () => {
  let ds: DataSource;
  let plans: PlanStore;

  beforeAll(async () => {
    ds = makeDataSource();
    await ds.initialize();
    plans = new PlanStore(ds.getRepository(TeamTaskPlanEntity));
  });
  afterAll(async () => {
    await ds?.destroy();
  });
  beforeEach(async () => {
    await ds.query('TRUNCATE team_task_plans RESTART IDENTITY');
  });

  const attach = (overrides: Record<string, unknown> = {}) =>
    plans.attach({
      team: 'T1',
      taskId: 7,
      employee: 'alex',
      planMd: 'v1 of the plan',
      sessionId: 'sess-001',
      ...overrides,
    });

  it('upserts on (team, task, employee) — the latest plan wins', async () => {
    await attach();
    await attach({ planMd: 'v2 of the plan', sessionId: 'sess-002' });
    const all = await plans.listForTask('T1', 7);
    expect(all).toHaveLength(1);
    expect(all[0].planMd).toBe('v2 of the plan');
    expect(all[0].sessionId).toBe('sess-002');
  });

  it('re-attaching RESETS the lead approval — a revised plan needs the lead again', async () => {
    await attach();
    const approved = await plans.approve('T1', 7, 'alex');
    expect(approved?.leadStatus).toBe('approved');
    await attach({ planMd: 'revised after approval' });
    expect((await plans.get('T1', 7, 'alex'))?.leadStatus).toBe('pending');
  });

  it('several employees coexist on one task, listed in employee order', async () => {
    await attach({ employee: 'riley', planMd: 'riley plan' });
    await attach();
    const all = await plans.listForTask('T1', 7);
    expect(all.map((p) => p.employee)).toEqual(['alex', 'riley']);
  });

  it('approve targets one (team, task, employee) and misses cleanly', async () => {
    await attach();
    expect(await plans.approve('T1', 7, 'riley')).toBeUndefined();
    expect(await plans.approve('T2', 7, 'alex')).toBeUndefined(); // team isolation
    expect((await plans.approve('T1', 7, 'alex'))?.leadStatus).toBe('approved');
  });
});
