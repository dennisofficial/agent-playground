import {
  ENTITIES,
  Session as SessionEntity,
  SessionEvent as SessionEventEntity,
} from '@workspace/shared/schemas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { EWorkerEngineName } from '../engines/worker-engine.port';
import { PostgresSessionRegistry } from './postgres-session.registry';
import type { NewSession } from './session-registry.port';

// Construct the registry the way DI does — both repos. A fresh instance over the same DataSource
// stands in for the post-restart process.
function makeRegistry(ds: DataSource): PostgresSessionRegistry {
  return new PostgresSessionRegistry(
    ds.getRepository(SessionEntity),
    ds.getRepository(SessionEventEntity),
  );
}

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

const newSession = (overrides: Partial<NewSession> = {}): NewSession => ({
  task: 'plan the thing',
  worktreeId: 'wt-001',
  notifyThread: 'C1:root',
  engine: EWorkerEngineName.CLAUDE,
  ownerBot: 'alex',
  team: 'T1',
  project: 'proj',
  mode: 'plan',
  ...overrides,
});

describe('PostgresSessionRegistry (live Postgres)', () => {
  let ds: DataSource;
  let registry: PostgresSessionRegistry;

  beforeAll(async () => {
    ds = makeDataSource();
    await ds.initialize();
    registry = makeRegistry(ds);
  });
  afterAll(async () => {
    await ds?.destroy();
  });
  beforeEach(async () => {
    await ds.query('TRUNCATE sessions, session_events');
  });

  it('persists a created session and reads it back across a fresh registry instance', async () => {
    const created = await registry.create(newSession({ boardTaskId: 7 }));
    expect(created.id).toMatch(/^sess-/);
    expect(created.status).toBe('running');
    expect(created.boardTaskId).toBe(7);

    // A SECOND registry over the same DB = the post-restart read. The row survives the process.
    const reborn = makeRegistry(ds);
    const got = await reborn.get(created.id);
    expect(got?.task).toBe('plan the thing');
    expect(got?.engine).toBe(EWorkerEngineName.CLAUDE);
    expect(got?.boardTaskId).toBe(7);
  });

  it('round-trips the engine resume handle + Q&A and clears fields written as undefined', async () => {
    const s = await registry.create(newSession());
    await registry.update(s.id, {
      status: 'idle',
      engineSessionId: 'engine-abc',
      lastReport: 'a plan',
      lastReportKind: 'plan',
      qa: [{ q: 'throw or null?', a: 'throw' }],
      turns: 1,
    });
    let got = await registry.get(s.id);
    expect(got?.status).toBe('idle');
    expect(got?.engineSessionId).toBe('engine-abc'); // the resume handle is durable
    expect(got?.lastReportKind).toBe('plan');
    expect(got?.qa).toEqual([{ q: 'throw or null?', a: 'throw' }]);

    // Next turn-end writes lastReportKind/planAttached as undefined → must NULL them, not keep stale.
    await registry.update(s.id, {
      status: 'idle',
      lastReport: 'prose',
      lastReportKind: undefined,
      planAttached: undefined,
      turns: 2,
    });
    got = await registry.get(s.id);
    expect(got?.lastReportKind).toBeUndefined();
    expect(got?.planAttached).toBeUndefined();
    expect(got?.engineSessionId).toBe('engine-abc'); // untouched keys keep their value
    expect(got?.turns).toBe(2);
  });

  it('filters list by owner/status and returns the most recent from latest()', async () => {
    const a = await registry.create(newSession({ ownerBot: 'alex' }));
    const b = await registry.create(newSession({ ownerBot: 'nora' }));
    await registry.update(b.id, { status: 'idle' });

    expect(
      (await registry.list({ ownerBot: 'alex' })).map((s) => s.id),
    ).toEqual([a.id]);
    expect((await registry.list({ status: 'idle' })).map((s) => s.id)).toEqual([
      b.id,
    ]);
    expect((await registry.latest())?.id).toBe(b.id);
    expect((await registry.latest('alex'))?.id).toBe(a.id);
  });

  it('persists the transcript and reads it back ordered across a restart', async () => {
    const s = await registry.create(newSession());
    await registry.appendProgress(s.id, { kind: 'text', text: 'thinking…' });
    await registry.appendProgress(s.id, {
      kind: 'tool',
      name: 'Read',
      detail: 'calc.ts',
    });
    await registry.appendProgress(s.id, { kind: 'result', text: 'done' });

    // The transcript is the durable single source of truth — a fresh instance reads it back in order.
    const reborn = makeRegistry(ds);
    const events = await reborn.progress(s.id);
    expect(events).toEqual([
      { kind: 'text', text: 'thinking…' },
      { kind: 'tool', name: 'Read', detail: 'calc.ts' },
      { kind: 'result', text: 'done' },
    ]);
  });

  it('reconciles interrupted running sessions to failed on boot, with a truthful resume message', async () => {
    // A session killed before its first turn finished (turns=0, no engine handle)…
    const fresh = await registry.create(newSession());
    // …vs one that completed a turn and was running again (has a resume handle)…
    const resumable = await registry.create(newSession());
    await registry.update(resumable.id, {
      engineSessionId: 'engine-xyz',
      turns: 1,
    });
    await registry.update(resumable.id, { status: 'running' }); // mid second turn at restart
    const idle = await registry.create(newSession());
    await registry.update(idle.id, { status: 'idle' });

    // Simulate a restart: a NEW registry instance runs its boot reconciliation.
    const reborn = makeRegistry(ds);
    await reborn.onApplicationBootstrap();

    const freshAfter = await reborn.get(fresh.id);
    expect(freshAfter?.status).toBe('failed');
    expect(freshAfter?.error).toContain('no saved context'); // truthful: nothing to resume

    const resumableAfter = await reborn.get(resumable.id);
    expect(resumableAfter?.status).toBe('failed');
    expect(resumableAfter?.error).toContain('resumes it with full context');
    expect(resumableAfter?.engineSessionId).toBe('engine-xyz'); // handle preserved

    // An idle session is untouched — only running zombies are swept.
    expect((await reborn.get(idle.id))?.status).toBe('idle');
  });
});
