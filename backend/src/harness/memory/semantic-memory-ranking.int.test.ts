import { ENTITIES, Fact } from '@workspace/shared/schemas';
import { DataSource, Repository } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Identity } from '../domain/identity';
import { EmbeddingProvider } from './embedding';
import { SemanticMemory } from './semantic-memory';

/**
 * Ranking regression test for the two-tier recall fix (Phase 2). Proves a strong-but-OLD fact is no
 * longer evicted from the top-k by fresher-but-weaker facts — the bug where a fact that directly
 * answers the query never surfaces because a tiny recency bonus flips near-ties.
 *
 * Deterministic vectors (no OpenAI): each fact has a controlled cosine to the query via its index-0
 * component, plus a UNIQUE off-axis component so facts stay distinct from EACH OTHER (cosine
 * c_a*c_b ≈ 0.78 < the 0.82 gray floor) and never dedup-merge on insert.
 */
const DIM = 1536;
/** Unit vector with cosine `c` to the query (e0), its remaining weight parked on a unique axis `k`. */
const vec = (c: number, k: number): number[] => {
  const v = new Array<number>(DIM).fill(0);
  v[0] = c;
  v[k] = Math.sqrt(1 - c * c);
  return v;
};

const QUERY = 'which database is primary';
const OLD_STRONG = 'primary database is postgres'; // cos 0.90 to query, but 90 days old
const FRESH = [
  'migrations run via the typeorm cli', // cos 0.88, fresh
  'pgvector powers embeddings', // cos 0.87, fresh
  'connection pool sized for 20', // cos 0.86, fresh
  'query results cached in redis', // cos 0.85, fresh
];

const VEC: Record<string, number[]> = {
  [QUERY]: vec(1, 1),
  [OLD_STRONG]: vec(0.9, 1),
  [FRESH[0]]: vec(0.88, 2),
  [FRESH[1]]: vec(0.87, 3),
  [FRESH[2]]: vec(0.86, 4),
  [FRESH[3]]: vec(0.85, 5),
};

class FakeEmbedder implements EmbeddingProvider {
  readonly model = 'fake-embedder';
  embed(text: string): Promise<number[]> {
    return Promise.resolve(VEC[text] ?? vec(0, 1500));
  }
}

const ID: Identity = {
  selfAgent: 'alex',
  team: 'local',
  project: 'local',
  participants: ['dennis'],
  speaker: 'dennis',
  surface: 'test',
  isChannel: true,
};

describe('SemanticMemory two-tier recall ranking (live Postgres)', () => {
  let ds: DataSource;
  let repo: Repository<Fact>;
  let mem: SemanticMemory;

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      username: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
      entities: ENTITIES,
      synchronize: false,
    });
    await ds.initialize();
    repo = ds.getRepository(Fact);
    mem = new SemanticMemory(repo, new FakeEmbedder());
  });

  afterAll(async () => {
    await ds?.destroy();
  });

  beforeEach(async () => {
    await repo.query('TRUNCATE facts RESTART IDENTITY');
    // Seed the four fresh facts (now) + the strong old one, then back-date the old one 90 days.
    for (const f of FRESH) {
      await mem.remember({ fact: f, tier: 'project', id: ID });
    }
    const { id } = await mem.remember({
      fact: OLD_STRONG,
      tier: 'project',
      id: ID,
    });
    await repo.query(
      `UPDATE facts SET updated_at = now() - interval '90 days' WHERE id = $1`,
      [id],
    );
  });

  it('surfaces the strong-but-old fact at k=1 (recency cannot evict the top relevance match)', async () => {
    const hits = await mem.recall(QUERY, ID, 1);
    expect(hits.map((h) => h.fact)).toEqual([OLD_STRONG]);
  });

  it('includes the strong-but-old fact within a small top-k alongside fresh near-ties', async () => {
    const hits = await mem.recall(QUERY, ID, 3);
    expect(hits.map((h) => h.fact)).toContain(OLD_STRONG);
    // Returned strongest-relevance-first: the direct answer leads, not buried mid-list.
    expect(hits[0].fact).toBe(OLD_STRONG);
  });

  it('still blends recency into the lower slots (fresh near-ties fill the rest)', async () => {
    const hits = await mem.recall(QUERY, ID, 3);
    // One relevance-reserved slot (the old fact) + two recency-blended fresh facts.
    expect(hits).toHaveLength(3);
    const fresh = hits.filter((h) => FRESH.includes(h.fact));
    expect(fresh.length).toBe(2);
  });
});
