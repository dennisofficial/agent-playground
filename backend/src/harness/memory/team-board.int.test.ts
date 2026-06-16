import {
  ENTITIES,
  TeamTask as TeamTaskEntity,
} from '@workspace/shared/schemas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { BoardStore, type BoardTask } from './board-store';

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

describe('BoardStore (live Postgres)', () => {
  let ds: DataSource;
  let board: BoardStore;

  beforeAll(async () => {
    ds = makeDataSource();
    await ds.initialize();
    board = new BoardStore(ds.getRepository(TeamTaskEntity));
  });
  afterAll(async () => {
    await ds?.destroy();
  });
  beforeEach(async () => {
    await ds.query('TRUNCATE team_tasks RESTART IDENTITY');
  });

  const create = (overrides: Record<string, unknown> = {}) =>
    board.create({
      team: 'T1',
      project: 'p',
      title: 'Build the thing',
      createdBy: 'sam',
      ...overrides,
    });

  it('two concurrent claims on one task — exactly one wins (the DB is the lock)', async () => {
    const t = asTask(await create());
    const [a, b] = await Promise.all([
      board.claim('T1', t.id, 'alex'),
      board.claim('T1', t.id, 'riley'),
    ]);
    const wins = [a, b].filter((r) => typeof r !== 'string');
    const losses = [a, b].filter((r) => r === 'taken');
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    const after = await board.get('T1', t.id);
    expect(after?.status).toBe('planning');
    expect(['alex', 'riley']).toContain(after?.assignee);
  });

  it('a task is unclaimable while a dependency is open, and unblocks when it completes', async () => {
    const dep = asTask(await create({ title: 'Contract first' }));
    const t = asTask(
      await create({ title: 'Build on it', dependsOn: [dep.id] }),
    );

    expect(await board.claim('T1', t.id, 'alex')).toBe('blocked');
    expect((await board.blockersOf('T1', [t])).get(t.id)).toEqual([dep.id]);

    asTask(await board.claim('T1', dep.id, 'maya'));
    await board.update('T1', dep.id, { status: 'done' });

    const claimed = asTask(await board.claim('T1', t.id, 'alex'));
    expect(claimed.status).toBe('planning');
    expect(claimed.assignee).toBe('alex');
  });

  it('a pre-assigned task is claimable by its assignee only', async () => {
    const t = asTask(await create({ assignee: 'riley' }));
    expect(await board.claim('T1', t.id, 'alex')).toBe('taken');
    const claimed = asTask(await board.claim('T1', t.id, 'riley'));
    expect(claimed.status).toBe('planning');
  });

  it('unknown dependency ids are rejected at create', async () => {
    const r = await create({ dependsOn: [12345] });
    expect(r).toEqual({ unknownDeps: [12345] });
  });

  it('team_id isolation: same numeric id space, no cross-team reads, claims, or deps', async () => {
    const t1 = asTask(await create({ team: 'T1' }));
    expect(await board.get('T2', t1.id)).toBeUndefined();
    expect(await board.claim('T2', t1.id, 'alex')).toBe('missing');
    // T1's task id is not a valid dependency on T2's board.
    const cross = await create({ team: 'T2', dependsOn: [t1.id] });
    expect(cross).toEqual({ unknownDeps: [t1.id] });
    expect(await board.list({ team: 'T2' })).toHaveLength(0);
  });

  it('depends_on int[] round-trips, and list filters by project/assignee/status', async () => {
    const a = asTask(await create({ title: 'A' }));
    const b = asTask(
      await create({ title: 'B', dependsOn: [a.id], assignee: 'alex' }),
    );
    expect((await board.get('T1', b.id))?.dependsOn).toEqual([a.id]);
    await create({ title: 'C', project: 'other' });

    expect(await board.list({ team: 'T1', project: 'p' })).toHaveLength(2);
    expect(await board.list({ team: 'T1', assignee: 'alex' })).toHaveLength(1);
    asTask(await board.claim('T1', a.id, 'maya'));
    expect(await board.list({ team: 'T1', status: 'planning' })).toHaveLength(
      1,
    );
  });

  it('shared_slug round-trips through create/update and list({sharedSlug}) is project-scoped', async () => {
    const a = asTask(await create({ title: 'A', sharedSlug: 'feat' }));
    expect((await board.get('T1', a.id))?.sharedSlug).toBe('feat');
    // a same-slug ticket in ANOTHER project must not group with it
    await create({ title: 'B', sharedSlug: 'feat', project: 'other' });
    const b = asTask(await create({ title: 'C' }));
    await board.update('T1', b.id, { sharedSlug: 'feat' });

    const group = await board.list({ team: 'T1', project: 'p', sharedSlug: 'feat' });
    expect(group.map((t) => t.title).sort()).toEqual(['A', 'C']);
    // clearing the slug drops it from the group
    await board.update('T1', b.id, { sharedSlug: null });
    expect(
      (await board.list({ team: 'T1', project: 'p', sharedSlug: 'feat' })).map((t) => t.title),
    ).toEqual(['A']);
  });

  it('countInFlightExecution counts only executing (a waiting self_review ticket frees its slot)', async () => {
    const a = asTask(await create({ title: 'A' }));
    const b = asTask(await create({ title: 'B' }));
    await board.update('T1', a.id, { status: 'executing' });
    await board.update('T1', b.id, { status: 'self_review' });
    // self_review must NOT count — otherwise a shared-feature group larger than the cap deadlocks.
    expect(await board.countInFlightExecution('T1')).toBe(1);
  });

  it('release puts a claimed task back up for grabs', async () => {
    const t = asTask(await create());
    asTask(await board.claim('T1', t.id, 'alex'));
    await board.update('T1', t.id, { status: 'open', assignee: null });
    const claimed = asTask(await board.claim('T1', t.id, 'riley'));
    expect(claimed.assignee).toBe('riley');
  });

  it("the approval statuses round-trip (plain-text column), and claim() won't take them", async () => {
    const t = asTask(await create({ assignee: 'alex' }));
    asTask(await board.claim('T1', t.id, 'alex'));

    await board.update('T1', t.id, { status: 'awaiting_approval' });
    expect((await board.get('T1', t.id))?.status).toBe('awaiting_approval');
    expect(await board.claim('T1', t.id, 'riley')).toBe('taken');

    await board.update('T1', t.id, { status: 'approved' });
    expect((await board.get('T1', t.id))?.status).toBe('approved');
    expect(await board.claim('T1', t.id, 'riley')).toBe('taken');

    expect(
      await board.list({ team: 'T1', status: 'awaiting_approval' }),
    ).toHaveLength(0);
    expect(await board.list({ team: 'T1', status: 'approved' })).toHaveLength(
      1,
    );
  });

  it('transition() is an atomic CAS — two concurrent verdicts, exactly one wins', async () => {
    const t = asTask(await create({ assignee: 'alex' }));
    asTask(await board.claim('T1', t.id, 'alex'));
    await board.update('T1', t.id, { status: 'awaiting_approval' });

    const [a, b] = await Promise.all([
      board.transition('T1', t.id, 'awaiting_approval', { status: 'approved' }),
      board.transition('T1', t.id, 'awaiting_approval', {
        status: 'open',
        assignee: null,
      }),
    ]);
    const wins = [a, b].filter(Boolean);
    expect(wins).toHaveLength(1);
    // Whichever verdict won is the durable one; the loser changed nothing.
    const after = await board.get('T1', t.id);
    expect(after?.status).toBe(wins[0]!.status);
  });

  it('a deny-release (transition to open, assignee cleared) leaves the task re-claimable', async () => {
    const t = asTask(await create({ assignee: 'alex' }));
    asTask(await board.claim('T1', t.id, 'alex'));
    await board.update('T1', t.id, { status: 'awaiting_approval' });
    const released = await board.transition('T1', t.id, 'awaiting_approval', {
      status: 'open',
      assignee: null,
    });
    expect(released?.status).toBe('open');
    expect(released?.assignee).toBeUndefined();
    const reclaimed = asTask(await board.claim('T1', t.id, 'riley'));
    expect(reclaimed.assignee).toBe('riley');
  });

  it("an 'awaiting_approval' dependency still BLOCKS its dependents — only 'done' satisfies", async () => {
    const dep = asTask(await create({ title: 'Plan first', assignee: 'alex' }));
    const t = asTask(
      await create({ title: 'Build on it', dependsOn: [dep.id] }),
    );
    asTask(await board.claim('T1', dep.id, 'alex'));
    await board.update('T1', dep.id, { status: 'awaiting_approval' });

    expect(await board.claim('T1', t.id, 'riley')).toBe('blocked');
    expect((await board.blockersOf('T1', [t])).get(t.id)).toEqual([dep.id]);

    await board.update('T1', dep.id, { status: 'done' });
    expect(typeof (await board.claim('T1', t.id, 'riley'))).not.toBe('string');
  });
});
