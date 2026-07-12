/**
 * Cross-tenant isolation for `MemoryStore` (live Postgres). The shared/global memory tier
 * (`org_id IS NULL`, "recalled everywhere") was removed: recall filters strictly on `org_id = :team`
 * with no NULL fall-through, and `memory.org_id` is NOT NULL at the DB. This proves the tenant
 * boundary functionally — the SAME fact stored under two orgs in the SAME scope is only ever recalled
 * by its owning org, never leaked across the tenant boundary.
 *
 * Embeddings are faked deterministically (identical text → identical unit vector), so the test is
 * hermetic — no OpenAI key, no network. The old "global tier" is proven gone structurally by the
 * NOT NULL migration + the removal of `OR org_id IS NULL`; this covers the runtime filter.
 */

import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomNamingStrategy } from '../../_lib/database/custom-naming.strategy';
import { DB_CONNECTION } from '../persistence/database.module';
import { ENTITIES, MemoryEntity } from '../persistence/entities';
import { EMBED_DIM, EMBED_MODEL, type EmbeddingProvider } from './embedding';
import { MemoryStore } from './memory.store';

const ORG_A = '2b111111-1111-4111-8111-111111111111';
const ORG_B = '2b222222-2222-4222-8222-222222222222';
const SHARED_SCOPE = 'team:cross-tenant-isolation';
const FACT = 'The deploy pipeline runs on GitHub Actions with a manual approval gate.';

/** Deterministic embedder: identical text → identical unit vector (cosine 1 to itself). */
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

async function purge(ds: DataSource): Promise<void> {
  await ds.query(`DELETE FROM memory WHERE org_id = ANY($1)`, [[ORG_A, ORG_B]]);
  await ds.query(`DELETE FROM organizations WHERE id = ANY($1)`, [[ORG_A, ORG_B]]);
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
  });

  afterAll(async () => {
    if (ds) await purge(ds).catch(() => undefined);
    await mod?.close();
  });

  it('recall returns only the querying tenant’s fact, never the other org’s identical fact', async () => {
    // Same fact text, same scope, two different tenants.
    const a = await store.remember({ fact: FACT, scope: SHARED_SCOPE, orgId: ORG_A });
    const b = await store.remember({ fact: FACT, scope: SHARED_SCOPE, orgId: ORG_B });
    expect(a.action).toBe('inserted');
    expect(b.action).toBe('inserted');
    // Cross-org: no dedup merge — the two orgs hold distinct rows.
    expect(a.id).not.toBe(b.id);

    const hits = await store.recall(FACT, { scopes: [SHARED_SCOPE], orgId: ORG_A });

    // Exactly org A's row — org B's identical fact never fell through.
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(a.id);
    expect(hits.every((h) => h.org_id === ORG_A)).toBe(true);
    expect(hits.some((h) => h.org_id === ORG_B)).toBe(false);
  });
});
