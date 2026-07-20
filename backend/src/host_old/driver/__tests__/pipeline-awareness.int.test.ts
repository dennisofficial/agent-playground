import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomNamingStrategy } from '../../../_lib/database/custom-naming.strategy';
import { DB_CONNECTION } from '../../persistence/database.module';
import { ENTITIES } from '../../persistence/entities';
import { PipelineAwarenessStore } from '../pipeline-awareness.store';

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

const marker = (id: string, text = id) => ({
  id,
  text,
  at: '2026-06-26T00:00:00.000Z',
});

describe('PipelineAwarenessStore (live Postgres)', () => {
  let mod: TestingModule;
  let ds: DataSource;
  let store: PipelineAwarenessStore;
  let repoId: string;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [TypeOrmModule.forRoot(dbOpts()), TypeOrmModule.forFeature(ENTITIES, DB_CONNECTION)],
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
    await ds?.query(`DELETE FROM jobs WHERE org_id = $1`, [ORG_ID]).catch(() => undefined);
    await ds?.query(`DELETE FROM repos WHERE org_id = $1`, [ORG_ID]).catch(() => undefined);
    await ds?.query(`DELETE FROM organizations WHERE id = $1`, [ORG_ID]).catch(() => undefined);
    await mod?.close();
  });

  async function newThread(): Promise<string> {
    const rows = await ds.query(
      `INSERT INTO jobs (org_id, repo_id, origin, title) VALUES ($1, $2, 'chat', 'awareness') RETURNING id`,
      [ORG_ID, repoId],
    );
    return rows[0].id;
  }

  it('defaults to an empty buffer for a fresh thread (the migration backfill)', async () => {
    const jobId = await newThread();
    const rows = await ds.query(`SELECT pipeline_awareness AS a FROM jobs WHERE id = $1`, [jobId]);
    expect(rows[0].a).toEqual({ markerQueue: [], conveyedStateSig: null });
  });

  it('appends idempotently (same id → one marker) and survives a "process restart"', async () => {
    const jobId = await newThread();
    await store.appendMarker(jobId, marker('approved:dr-1', 'Plan approved.'));
    await store.appendMarker(jobId, marker('approved:dr-1', 'Plan approved.')); // dup id
    await store.appendMarker(jobId, marker('dispatched:dr-1', 'Build started.'));

    const fresh = new PipelineAwarenessStore(ds);
    const { markers } = await fresh.drainAndAdvance(jobId, null);
    expect(markers.map((m) => m.id)).toEqual(['approved:dr-1', 'dispatched:dr-1']);
  });

  it('drains markers exactly once (a second drain is empty)', async () => {
    const jobId = await newThread();
    await store.appendMarker(jobId, marker('m1'));
    const first = await store.drainAndAdvance(jobId, null);
    expect(first.markers.map((m) => m.id)).toEqual(['m1']);
    const second = await store.drainAndAdvance(jobId, null);
    expect(second.markers).toEqual([]);
  });

  it('advances the state watermark — conveys a change once, then suppresses the unchanged repeat', async () => {
    const jobId = await newThread();
    const a = await store.drainAndAdvance(jobId, 'sig-running-1');
    expect(a.stateChanged).toBe(true); // first time this signature is seen → convey
    const b = await store.drainAndAdvance(jobId, 'sig-running-1');
    expect(b.stateChanged).toBe(false); // unchanged → suppressed
    const c = await store.drainAndAdvance(jobId, 'sig-running-2');
    expect(c.stateChanged).toBe(true); // a real change → convey again
  });

  it('a null signature (no build yet) never advances the watermark', async () => {
    const jobId = await newThread();
    const { stateChanged } = await store.drainAndAdvance(jobId, null);
    expect(stateChanged).toBe(false);
  });

  it('the drain/append RACE drops no marker (FOR UPDATE serializes the human turn vs the driver)', async () => {
    const jobId = await newThread();
    const ids = Array.from({ length: 20 }, (_, i) => `step:${i}:done`);
    const appends = ids.map((id) => store.appendMarker(jobId, marker(id)));
    const drain = store.drainAndAdvance(jobId, null);
    const [{ markers: drained }] = await Promise.all([
      drain,
      ...appends.map((p) => p.then(() => undefined)),
    ]);

    const remaining = (await store.drainAndAdvance(jobId, null)).markers;
    const seen = [...drained, ...remaining].map((m) => m.id).sort();
    expect(seen).toEqual([...ids].sort());
  });
});
