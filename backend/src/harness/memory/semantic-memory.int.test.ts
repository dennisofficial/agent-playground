import { ENTITIES, Fact } from '@workspace/shared/schemas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DataSource, Repository } from 'typeorm';
import { EmbeddingProvider } from './embedding';
import { Identity } from '../domain/identity';
import { SemanticMemory } from './semantic-memory';

// Deterministic unit vectors so cosine is exact (no OpenAI calls).
const DIM = 1536;
const unit = (i: number): number[] => {
  const v = new Array<number>(DIM).fill(0);
  v[i] = 1;
  return v;
};
// Unit vector at cosine `c` to unit(i): [c, sqrt(1-c^2), 0, …].
const near = (i: number, c: number): number[] => {
  const v = new Array<number>(DIM).fill(0);
  v[i] = c;
  v[i + 1] = Math.sqrt(1 - c * c);
  return v;
};

const VEC: Record<string, number[]> = {
  A: unit(0),
  'A reworded': near(0, 0.97), // ≥ DEDUP_THRESHOLD (0.92) → merge
  B: unit(1), // cosine 0 to A → distinct + below recall floor
  'query about A': unit(0),
};

class FakeEmbedder implements EmbeddingProvider {
  readonly model = 'fake-embedder';
  async embed(text: string): Promise<number[]> {
    return VEC[text] ?? unit(1500); // unknown text → far from everything
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

describe('SemanticMemory (pgvector, live Postgres)', () => {
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
  });

  it('inserts a new fact', async () => {
    const r = await mem.remember({ fact: 'A', tier: 'project', id: ID });
    expect(r.action).toBe('inserted');
    expect(await repo.count()).toBe(1);
  });

  it('dedup-merges a near-duplicate (cosine 0.97 ≥ 0.92), not a second row', async () => {
    const first = await mem.remember({ fact: 'A', tier: 'project', id: ID });
    const second = await mem.remember({ fact: 'A reworded', tier: 'project', id: ID });
    expect(second.action).toBe('updated');
    expect(second.id).toBe(first.id);
    expect(await repo.count()).toBe(1);
  });

  it('inserts a distinct fact (cosine 0 < gray floor)', async () => {
    await mem.remember({ fact: 'A', tier: 'project', id: ID });
    const r = await mem.remember({ fact: 'B', tier: 'project', id: ID });
    expect(r.action).toBe('inserted');
    expect(await repo.count()).toBe(2);
  });

  it('recall returns the relevant fact via pgvector and filters below the floor', async () => {
    await mem.remember({ fact: 'A', tier: 'project', id: ID });
    await mem.remember({ fact: 'B', tier: 'project', id: ID });
    const hits = await mem.recall('query about A', ID, 5);
    expect(hits.map((h) => h.fact)).toEqual(['A']); // A (cos 1); B (cos 0) below MIN_RECALL_SIM
  });

  it('recall respects scope — another project is not visible', async () => {
    await mem.remember({ fact: 'A', tier: 'project', id: ID });
    await mem.remember({ fact: 'A', tier: 'project', id: { ...ID, project: 'other' } });
    const hits = await mem.recall('query about A', ID, 5);
    expect(hits.length).toBe(1); // only project:local, not project:other
  });

  it('forgetFactById soft-deletes (scope-checked) and recall no longer returns it', async () => {
    const { id } = await mem.remember({ fact: 'A', tier: 'project', id: ID });
    expect(await mem.forgetFactById(id, ID)).not.toBeNull();
    expect(await mem.recall('query about A', ID, 5)).toEqual([]);
  });
});
