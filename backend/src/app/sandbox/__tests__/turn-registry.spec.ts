import { QueryFailedError, type Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { ActiveTurnEntity } from '../../persistence/entities';
import { BrainTurnAlreadyRunningError, TurnRegistry } from '../turn-registry.service';

/** A Postgres unique-violation error as TypeORM surfaces it (SQLSTATE 23505 on `.code`). */
function uniqueViolation(): QueryFailedError {
  const err = new QueryFailedError('insert', [], new Error('duplicate key'));
  (err as QueryFailedError & { code?: string }).code = '23505';
  return err;
}

/** A vi-mock repo capturing the calls TurnRegistry makes (no real Postgres). */
function makeRepo(rows: Partial<ActiveTurnEntity>[] = []) {
  const repo = {
    create: vi.fn((d: Partial<ActiveTurnEntity>) => d as ActiveTurnEntity),
    save: vi.fn(async (d: ActiveTurnEntity) => d),
    update: vi.fn(async () => ({ affected: 1 })),
    delete: vi.fn(async () => ({ affected: 1 })),
    findOne: vi.fn(async () => rows[0] ?? null),
    find: vi.fn(async () => rows as ActiveTurnEntity[]),
    count: vi.fn(async () => rows.length),
  };
  return repo as unknown as Repository<ActiveTurnEntity> & typeof repo;
}

const REGISTER = {
  turnId: 't1',
  jobId: 'th1',
  orgId: 'org1',
  channel: 'repo1',
  lane: 'main',
  kind: 'brain' as const,
  containerId: 'c1',
  ctx: { orgId: 'org1', repoId: 'repo1', jobId: 'th1', author: 'U1' },
};

describe('TurnRegistry', () => {
  it('register persists a running row with a 0-0 cursor and no heartbeat yet', async () => {
    const repo = makeRepo();
    await new TurnRegistry(repo, makeRepo() as never).register(REGISTER);
    expect(repo.save).toHaveBeenCalledOnce();
    const saved = repo.save.mock.calls[0][0];
    expect(saved).toMatchObject({
      turn_id: 't1',
      job_id: 'th1',
      status: 'running',
      events_last_id: '0-0',
      last_heartbeat_at: null,
      kind: 'brain',
      ctx: REGISTER.ctx,
    });
  });

  it('register persists steerable:true when the caller passes it', async () => {
    const repo = makeRepo();
    await new TurnRegistry(repo, makeRepo() as never).register({
      ...REGISTER,
      steerable: true,
    });
    const saved = repo.save.mock.calls[0][0];
    expect(saved).toMatchObject({ steerable: true });
  });

  it('register defaults steerable to false when omitted', async () => {
    const repo = makeRepo();
    await new TurnRegistry(repo, makeRepo() as never).register(REGISTER);
    const saved = repo.save.mock.calls[0][0];
    expect(saved).toMatchObject({ steerable: false });
  });

  it('register maps a unique-violation on a BRAIN turn to BrainTurnAlreadyRunningError (the single-turn guard)', async () => {
    const repo = makeRepo();
    repo.save.mockRejectedValueOnce(uniqueViolation());
    await expect(
      new TurnRegistry(repo, makeRepo() as never).register(REGISTER),
    ).rejects.toBeInstanceOf(BrainTurnAlreadyRunningError);
  });

  it('register rethrows a unique-violation for a NON-brain turn (only brain turns are guarded)', async () => {
    const repo = makeRepo();
    repo.save.mockRejectedValueOnce(uniqueViolation());
    await expect(
      new TurnRegistry(repo, makeRepo() as never).register({
        ...REGISTER,
        kind: 'step',
      }),
    ).rejects.not.toBeInstanceOf(BrainTurnAlreadyRunningError);
  });

  it('register rethrows a non-unique DB error unchanged', async () => {
    const repo = makeRepo();
    const boom = new Error('connection reset');
    repo.save.mockRejectedValueOnce(boom);
    await expect(new TurnRegistry(repo, makeRepo() as never).register(REGISTER)).rejects.toBe(boom);
  });

  it('heartbeat stamps last_heartbeat_at and advances the cursor when an id is given', async () => {
    const repo = makeRepo();
    const at = new Date('2026-06-29T00:00:00Z');
    await new TurnRegistry(repo, makeRepo() as never).heartbeat('t1', '5-0', at);
    expect(repo.update).toHaveBeenCalledWith(
      { turn_id: 't1' },
      { last_heartbeat_at: at, events_last_id: '5-0' },
    );
  });

  it('heartbeat without an id only stamps liveness (cursor untouched)', async () => {
    const repo = makeRepo();
    const at = new Date('2026-06-29T00:00:00Z');
    await new TurnRegistry(repo, makeRepo() as never).heartbeat('t1', undefined, at);
    expect(repo.update).toHaveBeenCalledWith({ turn_id: 't1' }, { last_heartbeat_at: at });
  });

  it('finalize stamps the terminal status then deletes the live row', async () => {
    const repo = makeRepo();
    await new TurnRegistry(repo, makeRepo() as never).finalize('t1', 'done');
    expect(repo.update).toHaveBeenCalledWith({ turn_id: 't1' }, { status: 'done' });
    expect(repo.delete).toHaveBeenCalledWith({ turn_id: 't1' });
  });

  it('listRunning queries status=running', async () => {
    const repo = makeRepo([{ turn_id: 't1', status: 'running' }]);
    const out = await new TurnRegistry(repo, makeRepo() as never).listRunning();
    expect(repo.find).toHaveBeenCalledWith({ where: { status: 'running' } });
    expect(out).toHaveLength(1);
  });

  it('runningSteerableTurn queries the running+steerable row for (job_id, lane)', async () => {
    const row = {
      turn_id: 't1',
      job_id: 'th1',
      lane: 'thread:sec-be',
      status: 'running',
      steerable: true,
    } as const;
    const repo = makeRepo([row]);
    const out = await new TurnRegistry(repo, makeRepo() as never).runningSteerableTurn(
      'th1',
      'thread:sec-be',
    );
    expect(repo.findOne).toHaveBeenCalledWith({
      where: {
        job_id: 'th1',
        lane: 'thread:sec-be',
        status: 'running',
        steerable: true,
      },
    });
    expect(out).toEqual(row);
  });

  it('tool dedup: records a reply and reads it back by (turn_id, tool_call_id)', async () => {
    const turns = makeRepo();
    const execs = makeRepo();
    const reg = new TurnRegistry(turns, execs as never);

    await reg.recordToolReply('t1', 'call-1', 'submit_plan', {
      t: 'tool_response',
      id: 'call-1',
      result: { ok: true },
    });
    expect(execs.save).toHaveBeenCalledOnce();
    expect(execs.save.mock.calls[0][0]).toMatchObject({
      turn_id: 't1',
      tool_call_id: 'call-1',
      tool_name: 'submit_plan',
      reply: { t: 'tool_response', id: 'call-1', result: { ok: true } },
    });

    // getToolReply returns the row's reply when present, else null.
    execs.findOne.mockResolvedValueOnce({
      reply: { t: 'tool_response', id: 'call-1', result: 42 },
    } as never);
    expect(await reg.getToolReply('t1', 'call-1')).toEqual({
      t: 'tool_response',
      id: 'call-1',
      result: 42,
    });
    execs.findOne.mockResolvedValueOnce(null as never);
    expect(await reg.getToolReply('t1', 'nope')).toBeNull();
  });

  it("failRunningForJob deletes only that job's running rows and reports how many were dropped", async () => {
    const repo = makeRepo();
    repo.delete.mockResolvedValueOnce({ affected: 2 } as never);
    const out = await new TurnRegistry(repo, makeRepo() as never).failRunningForJob('th1');
    expect(repo.delete).toHaveBeenCalledWith({
      job_id: 'th1',
      status: 'running',
    });
    expect(out).toBe(2);
  });

  it('failRunningForJob returns 0 when nothing was running for that job', async () => {
    const repo = makeRepo();
    repo.delete.mockResolvedValueOnce({ affected: undefined } as never);
    const out = await new TurnRegistry(repo, makeRepo() as never).failRunningForJob('th-idle');
    expect(out).toBe(0);
  });

  it('findStale merges stale-heartbeat + never-beat rows, de-duped by turn_id', async () => {
    const repo = makeRepo();
    // First find() = stale-heartbeat rows; second = never-beat rows (one overlaps t1).
    repo.find
      .mockResolvedValueOnce([{ turn_id: 't1' }, { turn_id: 't2' }] as ActiveTurnEntity[])
      .mockResolvedValueOnce([{ turn_id: 't1' }, { turn_id: 't3' }] as ActiveTurnEntity[]);
    const out = await new TurnRegistry(repo, makeRepo() as never).findStale(60_000);
    expect(out.map((t) => t.turn_id).sort()).toEqual(['t1', 't2', 't3']); // t1 not duplicated
  });
});
