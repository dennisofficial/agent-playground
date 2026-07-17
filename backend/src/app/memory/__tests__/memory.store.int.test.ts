
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomNamingStrategy } from '../../../_lib/database/custom-naming.strategy';
import { DB_CONNECTION } from '../../persistence/database.module';
import { ENTITIES, MemoryEntity } from '../../persistence/entities';
import { EMBED_DIM, EMBED_MODEL, type EmbeddingProvider } from '../embedding';
import { MemoryStore } from '../memory.store';

const ORG_A = '2b111111-1111-4111-8111-111111111111';
const ORG_B = '2b222222-2222-4222-8222-222222222222';
const ORG_C = '2b333333-3333-4333-8333-333333333333';
const ORG_D = '2b444444-4444-4444-8444-444444444444';
const SHARED_SCOPE = 'team:cross-tenant-isolation';
const MUTATION_SCOPE = 'team:forget-update-tests';
const FACT = 'The deploy pipeline runs on GitHub Actions with a manual approval gate.';

class FakeEmbedder implements EmbeddingProvider {
  readonly model = EMBED_MODEL;
  async embed(text: string): Promise<number[]> {
    const v = new Array<number>(EMBED_DIM).fill(0);
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
    v[h % EMBED_DIM] = 1;
    return v;
  }
}

class ThrowingEmbedder implements EmbeddingProvider {
  readonly model = EMBED_MODEL;
  async embed(): Promise<number[]> {
    throw new Error('embedding should not be called for a non-matching row');
  }
}

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

async function seedOrg(ds: DataSource, id: string, slug: string): Promise<void> {
  await ds.query(
    `INSERT INTO organizations (id, name, slug, status) VALUES ($1, $2, $3, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [id, `Isolation Org ${slug}`, `isolation-${slug}`],
  );
}

const ALL_ORGS = [ORG_A, ORG_B, ORG_C, ORG_D];

async function purge(ds: DataSource): Promise<void> {
  await ds.query(`DELETE FROM memory WHERE org_id = ANY($1)`, [ALL_ORGS]);
  await ds.query(`DELETE FROM organizations WHERE id = ANY($1)`, [ALL_ORGS]);
}

describe('MemoryStore cross-tenant isolation (live Postgres)', () => {
  let mod: TestingModule;
  let ds: DataSource;
  let store: MemoryStore;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [TypeOrmModule.forRoot(dbOpts())],
    }).compile();
    ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    const repo = ds.getRepository(MemoryEntity);
    store = new MemoryStore(repo, new FakeEmbedder());

    await purge(ds);
    await seedOrg(ds, ORG_A, 'a');
    await seedOrg(ds, ORG_B, 'b');
    await seedOrg(ds, ORG_C, 'c');
    await seedOrg(ds, ORG_D, 'd');
  });

  afterAll(async () => {
    if (ds) await purge(ds).catch(() => undefined);
    await mod?.close();
  });

  it('recall returns only the querying tenant’s fact, never the other org’s identical fact', async () => {
    const a = await store.remember({
      fact: FACT,
      scope: SHARED_SCOPE,
      orgId: ORG_A,
    });
    const b = await store.remember({
      fact: FACT,
      scope: SHARED_SCOPE,
      orgId: ORG_B,
    });
    expect(a.action).toBe('inserted');
    expect(b.action).toBe('inserted');
    expect(a.id).not.toBe(b.id);

    const hits = await store.recall(FACT, {
      scopes: [SHARED_SCOPE],
      orgId: ORG_A,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(a.id);
    expect(hits.every((h) => h.org_id === ORG_A)).toBe(true);
    expect(hits.some((h) => h.org_id === ORG_B)).toBe(false);
  });

  it('forget soft-deletes; a second forget of the same id is a no-op', async () => {
    const { id } = await store.remember({
      fact: 'The staging database is refreshed from prod nightly at 02:00 UTC.',
      scope: MUTATION_SCOPE,
      orgId: ORG_C,
    });

    const first = await store.forget(id, ORG_C);
    expect(first).toEqual({ deleted: true });

    const hits = await store.recall(
      'The staging database is refreshed from prod nightly at 02:00 UTC.',
      { scopes: [MUTATION_SCOPE], orgId: ORG_C },
    );
    expect(hits.some((h) => h.id === id)).toBe(false);

    const second = await store.forget(id, ORG_C);
    expect(second).toEqual({ deleted: false });
  });

  it('forget under a foreign org is a no-op and leaves the fact recallable', async () => {
    const { id } = await store.remember({
      fact: 'The on-call rotation is managed in PagerDuty with weekly handoffs.',
      scope: MUTATION_SCOPE,
      orgId: ORG_C,
    });

    const result = await store.forget(id, ORG_D);
    expect(result).toEqual({ deleted: false });

    const hits = await store.recall(
      'The on-call rotation is managed in PagerDuty with weekly handoffs.',
      { scopes: [MUTATION_SCOPE], orgId: ORG_C },
    );
    expect(hits.some((h) => h.id === id)).toBe(true);
  });

  it('updateFact rewrites the stored text so recall matches the new text, not the old', async () => {
    const oldText = 'The billing service retries failed webhooks up to 3 times.';
    const newText = 'The billing service retries failed webhooks up to 7 times with backoff.';
    const { id } = await store.remember({
      fact: oldText,
      scope: MUTATION_SCOPE,
      orgId: ORG_C,
    });

    const result = await store.updateFact(id, newText, ORG_C);
    expect(result).toEqual({ updated: true });

    const newHits = await store.recall(newText, {
      scopes: [MUTATION_SCOPE],
      orgId: ORG_C,
    });
    expect(newHits.some((h) => h.id === id && h.fact === newText)).toBe(true);

    const oldHits = await store.recall(oldText, {
      scopes: [MUTATION_SCOPE],
      orgId: ORG_C,
    });
    expect(oldHits.some((h) => h.id === id)).toBe(false);
  });

  it('updateFact is a no-op under a foreign org or on an already-forgotten id', async () => {
    const original = 'The support queue SLA is 4 business hours for P1 tickets.';
    const { id } = await store.remember({
      fact: original,
      scope: MUTATION_SCOPE,
      orgId: ORG_C,
    });

    const foreignAttempt = await store.updateFact(id, 'This should never land.', ORG_D);
    expect(foreignAttempt).toEqual({ updated: false });

    const stillOriginal = await store.recall(original, {
      scopes: [MUTATION_SCOPE],
      orgId: ORG_C,
    });
    expect(stillOriginal.some((h) => h.id === id && h.fact === original)).toBe(true);

    const { deleted } = await store.forget(id, ORG_C);
    expect(deleted).toBe(true);

    const forgottenAttempt = await store.updateFact(id, 'This should never land either.', ORG_C);
    expect(forgottenAttempt).toEqual({ updated: false });
  });

  it('updateFact does not embed when the id is unknown, foreign, or already forgotten', async () => {
    const guarded = new MemoryStore(ds.getRepository(MemoryEntity), new ThrowingEmbedder());
    const { id } = await store.remember({
      fact: 'The incident channel is #ops-incidents.',
      scope: MUTATION_SCOPE,
      orgId: ORG_C,
    });

    await expect(
      guarded.updateFact('2b999999-9999-4999-8999-999999999999', 'This should never embed.', ORG_C),
    ).resolves.toEqual({ updated: false });

    await expect(guarded.updateFact(id, 'This should never embed.', ORG_D)).resolves.toEqual({
      updated: false,
    });

    await store.forget(id, ORG_C);
    await expect(guarded.updateFact(id, 'This should never embed.', ORG_C)).resolves.toEqual({
      updated: false,
    });
  });
});
