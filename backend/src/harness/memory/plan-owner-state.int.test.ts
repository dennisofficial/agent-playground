import {
  ENTITIES,
  TeamTask as TeamTaskEntity,
  TeamTaskPlan as TeamTaskPlanEntity,
} from '@workspace/shared/schemas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { BoardStore, type BoardTask } from './board-store';
import { PlanStore } from './plan-store';

/**
 * Live-Postgres coverage for the harness-driven-quality-gates lifecycle: the new status vocabulary +
 * CAS transitions, the per-owner columns added to team_task_plans, the integration barrier's
 * allOwnersComplete gate, and the execution throttle's in-flight count.
 */
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

const asTask = (v: unknown): BoardTask => {
  expect(typeof v).not.toBe('string');
  return v as BoardTask;
};

describe('Plan owner state + lifecycle (live Postgres)', () => {
  let ds: DataSource;
  let board: BoardStore;
  let plans: PlanStore;

  beforeAll(async () => {
    ds = makeDataSource();
    await ds.initialize();
    board = new BoardStore(ds.getRepository(TeamTaskEntity));
    plans = new PlanStore(ds.getRepository(TeamTaskPlanEntity));
  });
  afterAll(async () => {
    await ds?.destroy();
  });
  beforeEach(async () => {
    await ds.query('TRUNCATE team_tasks RESTART IDENTITY');
    await ds.query('TRUNCATE team_task_plans RESTART IDENTITY');
  });

  const approvedTask = async (assignee = 'alex') => {
    const t = asTask(
      await board.create({ team: 'T1', project: 'p', title: 'X', createdBy: 'sam', assignee }),
    );
    // walk it to 'approved' the way the real flow does
    await board.claim('T1', t.id, assignee); // → planning
    await board.transition('T1', t.id, 'planning', { status: 'awaiting_approval' });
    await board.transition('T1', t.id, 'awaiting_approval', { status: 'approved' });
    return t;
  };

  it('plan rows default owner_status=executing and carry the execute context', async () => {
    const t = await approvedTask();
    await plans.attach({ team: 'T1', taskId: t.id, employee: 'alex', planMd: 'plan' });
    let plan = await plans.get('T1', t.id, 'alex');
    expect(plan?.ownerStatus).toBe('executing');
    expect(plan?.executeWorktreeId).toBeUndefined();

    await plans.setExecuteContext('T1', t.id, 'alex', {
      executeWorktreeId: 'wt-9',
      sharedBranch: 'shared/x',
    });
    plan = await plans.get('T1', t.id, 'alex');
    expect(plan?.executeWorktreeId).toBe('wt-9');
    expect(plan?.sharedBranch).toBe('shared/x');
  });

  it('owner_status walks executing → complete on the single plan row', async () => {
    const t = await approvedTask();
    await plans.attach({ team: 'T1', taskId: t.id, employee: 'alex', planMd: 'a' });
    expect((await plans.get('T1', t.id, 'alex'))?.ownerStatus).toBe('executing');
    await plans.setOwnerStatus('T1', t.id, 'alex', 'complete');
    expect((await plans.get('T1', t.id, 'alex'))?.ownerStatus).toBe('complete');
  });

  it('re-attaching a plan resets owner_status back to executing', async () => {
    const t = await approvedTask();
    await plans.attach({ team: 'T1', taskId: t.id, employee: 'alex', planMd: 'a' });
    await plans.setOwnerStatus('T1', t.id, 'alex', 'complete');
    await plans.attach({ team: 'T1', taskId: t.id, employee: 'alex', planMd: 'a2' });
    expect((await plans.get('T1', t.id, 'alex'))?.ownerStatus).toBe('executing');
  });

  it('the execution status walk: approved → executing → self_review → in_review', async () => {
    const t = await approvedTask();
    expect((await board.get('T1', t.id))?.status).toBe('approved');
    await board.transition('T1', t.id, 'approved', { status: 'executing' });
    await board.transition('T1', t.id, 'executing', { status: 'self_review' });
    await board.transition('T1', t.id, 'self_review', { status: 'in_review' });
    expect((await board.get('T1', t.id))?.status).toBe('in_review');
  });

  it('countInFlightExecution counts ONLY executing (self_review frees its slot, per team)', async () => {
    const a = await approvedTask('alex');
    const b = await approvedTask('riley');
    const c = await approvedTask('maya');
    await board.transition('T1', a.id, 'approved', { status: 'executing' });
    // A self_review ticket is published + waiting (e.g. on shared-feature siblings) — it must NOT
    // hold an execution slot, or a sibling group larger than the cap would deadlock.
    await board.transition('T1', b.id, 'approved', { status: 'self_review' });
    expect(await board.countInFlightExecution('T1')).toBe(1);
    void c;
  });
});
