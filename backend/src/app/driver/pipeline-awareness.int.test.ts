/**
 * PipelineAwarenessStore — the DURABLE half of passive pipeline-milestone awareness, against live Postgres.
 *
 * Proves the buffer's three load-bearing properties:
 *  - idempotent append (a stage fires the same `id` repeatedly → one marker), and durability across a
 *    "process restart" (a fresh store instance reads the persisted buffer);
 *  - atomic drain + watermark advance (markers cleared once, state summary conveyed once per change);
 *  - the drain/append RACE doesn't drop a marker — the driver appends fire-and-forget while a human turn
 *    drains, and the `SELECT … FOR UPDATE` transaction serializes them so nothing is lost.
 *
 * Integration: real Postgres (atlas_test schema), no fakes (the store only touches the DataSource). Seeds
 * an org/repo/thread directly, then drives the store.
 */

import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomNamingStrategy } from '../../_lib/database/custom-naming.strategy';
import { DB_CONNECTION } from '../persistence/database.module';
import { ENTITIES } from '../persistence/entities';
import { PipelineAwarenessStore } from './pipeline-awareness.store';

const ORG_ID = '2aaaaaaa-1111-4111-8111-111111111111';

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

const marker = (id: string, text = id) => ({ id, text, at: '2026-06-26T00:00:00.000Z' });

describe('PipelineAwarenessStore (live Postgres)', () => {
  let mod: TestingModule;
  let ds: DataSource;
  let store: PipelineAwarenessStore;
  let repoId: string;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(dbOpts()),
        TypeOrmModule.forFeature(ENTITIES, DB_CONNECTION),
      ],
      providers: [PipelineAwarenessStore],
    }).compile();

    store = mod.get(PipelineAwarenessStore);
    ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));

    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'Awareness Org', 'awareness-org', 'active')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [ORG_ID],
    );
    const repoRows = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, access_ok)
       VALUES ($1, 'awareness-repo', 'Awareness Repo', 'https://github.com/x/y.git', 'main', true)
       ON CONFLICT (org_id, slug) DO UPDATE SET git_url = EXCLUDED.git_url RETURNING id`,
      [ORG_ID],
    );
    repoId = repoRows[0].id;
  });

  afterAll(async () => {
    await ds?.query(`DELETE FROM threads WHERE org_id = $1`, [ORG_ID]).catch(() => undefined);
    await ds?.query(`DELETE FROM repos WHERE org_id = $1`, [ORG_ID]).catch(() => undefined);
    await ds?.query(`DELETE FROM organizations WHERE id = $1`, [ORG_ID]).catch(() => undefined);
    await mod?.close();
  });

  async function newThread(): Promise<string> {
    const rows = await ds.query(
      `INSERT INTO threads (org_id, repo_id, origin, title) VALUES ($1, $2, 'chat', 'awareness') RETURNING id`,
      [ORG_ID, repoId],
    );
    return rows[0].id;
  }

  it('defaults to an empty buffer for a fresh thread (the migration backfill)', async () => {
    const threadId = await newThread();
    const rows = await ds.query(`SELECT pipeline_awareness AS a FROM threads WHERE id = $1`, [threadId]);
    expect(rows[0].a).toEqual({ markerQueue: [], conveyedStateSig: null });
  });

  it('appends idempotently (same id → one marker) and survives a "process restart"', async () => {
    const threadId = await newThread();
    await store.appendMarker(threadId, marker('approved:dr-1', 'Plan approved.'));
    await store.appendMarker(threadId, marker('approved:dr-1', 'Plan approved.')); // dup id
    await store.appendMarker(threadId, marker('dispatched:dr-1', 'Build started.'));

    // A FRESH store instance (a new process) reads the durable buffer — proves it's persisted, not in-mem.
    const fresh = new PipelineAwarenessStore(ds);
    const { markers } = await fresh.drainAndAdvance(threadId, null);
    expect(markers.map((m) => m.id)).toEqual(['approved:dr-1', 'dispatched:dr-1']);
  });

  it('drains markers exactly once (a second drain is empty)', async () => {
    const threadId = await newThread();
    await store.appendMarker(threadId, marker('m1'));
    const first = await store.drainAndAdvance(threadId, null);
    expect(first.markers.map((m) => m.id)).toEqual(['m1']);
    const second = await store.drainAndAdvance(threadId, null);
    expect(second.markers).toEqual([]);
  });

  it('advances the state watermark — conveys a change once, then suppresses the unchanged repeat', async () => {
    const threadId = await newThread();
    const a = await store.drainAndAdvance(threadId, 'sig-running-1');
    expect(a.stateChanged).toBe(true); // first time this signature is seen → convey
    const b = await store.drainAndAdvance(threadId, 'sig-running-1');
    expect(b.stateChanged).toBe(false); // unchanged → suppressed
    const c = await store.drainAndAdvance(threadId, 'sig-running-2');
    expect(c.stateChanged).toBe(true); // a real change → convey again
  });

  it('a null signature (no build yet) never advances the watermark', async () => {
    const threadId = await newThread();
    const { stateChanged } = await store.drainAndAdvance(threadId, null);
    expect(stateChanged).toBe(false);
  });

  it('the drain/append RACE drops no marker (FOR UPDATE serializes the human turn vs the driver)', async () => {
    const threadId = await newThread();
    // 20 concurrent appends (the driver) racing one drain (a human turn arriving mid-build).
    const ids = Array.from({ length: 20 }, (_, i) => `step:${i}:done`);
    const appends = ids.map((id) => store.appendMarker(threadId, marker(id)));
    const drain = store.drainAndAdvance(threadId, null);
    const [{ markers: drained }] = await Promise.all([drain, ...appends.map((p) => p.then(() => undefined))]);

    // Whatever the interleaving, every marker is accounted for EXACTLY once: some were drained, the rest
    // remain queued — none vanished (a lost-update would lose appends that landed during a read-clear).
    const remaining = (await store.drainAndAdvance(threadId, null)).markers;
    const seen = [...drained, ...remaining].map((m) => m.id).sort();
    expect(seen).toEqual([...ids].sort());
  });
});
