import { ENTITIES, Fact } from '@workspace/shared/schemas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DataSource, Repository } from 'typeorm';
import { rawRows } from '../memory/sql';
import { FactViewStore } from './fact-view.store';

// A zero vector of dimension 1536 — pgvector accepts it; we never touch embeddings in the viewer.
const ZERO_VEC = `[${new Array(1536).fill(0).join(',')}]`;

const TEAM = 'test-team';

interface InsertOpts {
  fact: string;
  scope: string;
  teamId?: string | null;
  assertedBy?: string | null;
  confidence?: number;
  deletedAt?: Date | null;
}

async function insertFact(
  repo: Repository<Fact>,
  opts: InsertOpts,
): Promise<number> {
  const rows = rawRows<{ id: number }>(
    await repo.manager.query(
      `INSERT INTO facts (fact, embedding, scope, team_id, asserted_by, confidence, created_at, updated_at, deleted_at)
       VALUES ($1, $2::vector, $3, $4, $5, $6, now(), now(), $7)
       RETURNING id`,
      [
        opts.fact,
        ZERO_VEC,
        opts.scope,
        opts.teamId !== undefined ? opts.teamId : TEAM,
        opts.assertedBy ?? null,
        opts.confidence ?? 1.0,
        opts.deletedAt ?? null,
      ],
    ),
  );
  return Number(rows[0].id);
}

describe('FactViewStore (live Postgres)', () => {
  let ds: DataSource;
  let repo: Repository<Fact>;
  let store: FactViewStore;

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
    store = new FactViewStore(repo);
  });

  afterAll(async () => {
    await ds?.destroy();
  });

  beforeEach(async () => {
    await repo.query('TRUNCATE facts RESTART IDENTITY');
  });

  // ── basic list ──────────────────────────────────────────────────────────────

  it('returns all active facts for the tenant', async () => {
    await insertFact(repo, { fact: 'fact A', scope: 'team:local' });
    await insertFact(repo, { fact: 'fact B', scope: 'project:proj1' });
    const { items, total } = await store.list(TEAM);
    expect(total).toBe(2);
    expect(items).toHaveLength(2);
    // embedding column must never appear in the response
    for (const item of items) {
      expect(Object.keys(item)).not.toContain('embedding');
    }
  });

  it('excludes soft-deleted facts by default', async () => {
    await insertFact(repo, { fact: 'live fact', scope: 'team:local' });
    await insertFact(repo, {
      fact: 'forgotten fact',
      scope: 'team:local',
      deletedAt: new Date(),
    });
    const { items, total } = await store.list(TEAM);
    expect(total).toBe(1);
    expect(items[0].content).toBe('live fact');
  });

  it('includes soft-deleted facts when includeDeleted=true', async () => {
    await insertFact(repo, { fact: 'live', scope: 'team:local' });
    await insertFact(repo, {
      fact: 'forgotten',
      scope: 'team:local',
      deletedAt: new Date(),
    });
    const { items, total } = await store.list(TEAM, { includeDeleted: true });
    expect(total).toBe(2);
    const forgotten = items.find((i) => i.content === 'forgotten');
    expect(forgotten?.deletedAt).not.toBeNull();
    const live = items.find((i) => i.content === 'live');
    expect(live?.deletedAt).toBeNull();
  });

  it('excludes a different tenant', async () => {
    await insertFact(repo, {
      fact: 'team-a fact',
      scope: 'team:local',
      teamId: 'team-a',
    });
    await insertFact(repo, {
      fact: 'team-b fact',
      scope: 'team:local',
      teamId: 'team-b',
    });
    const { total } = await store.list('team-a');
    expect(total).toBe(1);
  });

  // ── global (team_id IS NULL) facts ─────────────────────────────────────────

  it('includes global (team_id IS NULL) facts by default', async () => {
    await insertFact(repo, {
      fact: 'tenant fact',
      scope: 'team:local',
      teamId: TEAM,
    });
    await insertFact(repo, {
      fact: 'global fact',
      scope: 'team:local',
      teamId: null,
    });
    const { total } = await store.list(TEAM);
    expect(total).toBe(2);
  });

  it('excludes global facts when includeGlobal=false', async () => {
    await insertFact(repo, {
      fact: 'tenant fact',
      scope: 'team:local',
      teamId: TEAM,
    });
    await insertFact(repo, {
      fact: 'global fact',
      scope: 'team:local',
      teamId: null,
    });
    const { items, total } = await store.list(TEAM, { includeGlobal: false });
    expect(total).toBe(1);
    expect(items[0].content).toBe('tenant fact');
  });

  // ── tier filter ──────────────────────────────────────────────────────────────

  it('filters by tier=team', async () => {
    await insertFact(repo, { fact: 'team fact', scope: 'team:local' });
    await insertFact(repo, { fact: 'project fact', scope: 'project:proj1' });
    const { items } = await store.list(TEAM, { tier: 'team' });
    expect(items).toHaveLength(1);
    expect(items[0].tier).toBe('team');
    expect(items[0].content).toBe('team fact');
  });

  it('filters by tier=project', async () => {
    await insertFact(repo, { fact: 'team fact', scope: 'team:local' });
    await insertFact(repo, { fact: 'project fact', scope: 'project:proj1' });
    const { items } = await store.list(TEAM, { tier: 'project' });
    expect(items).toHaveLength(1);
    expect(items[0].tier).toBe('project');
    expect(items[0].projectId).toBe('proj1');
  });

  it('filters by tier=bot', async () => {
    await insertFact(repo, { fact: 'bot fact', scope: 'bot:alex' });
    await insertFact(repo, { fact: 'pair fact', scope: 'pair:alex:dennis' });
    const { items } = await store.list(TEAM, { tier: 'bot' });
    expect(items).toHaveLength(1);
    expect(items[0].tier).toBe('bot');
    expect(items[0].botId).toBe('alex');
  });

  it('filters by tier=private', async () => {
    await insertFact(repo, { fact: 'bot fact', scope: 'bot:alex' });
    await insertFact(repo, { fact: 'pair fact', scope: 'pair:alex:dennis' });
    const { items } = await store.list(TEAM, { tier: 'private' });
    expect(items).toHaveLength(1);
    expect(items[0].tier).toBe('private');
    expect(items[0].botId).toBe('alex');
    expect(items[0].humanId).toBe('dennis');
  });

  // ── projectId filter ─────────────────────────────────────────────────────────

  it('filters by projectId (exact scope match)', async () => {
    await insertFact(repo, { fact: 'proj1 fact', scope: 'project:proj1' });
    await insertFact(repo, { fact: 'proj2 fact', scope: 'project:proj2' });
    const { items } = await store.list(TEAM, { projectId: 'proj1' });
    expect(items).toHaveLength(1);
    expect(items[0].projectId).toBe('proj1');
  });

  // ── botId filter ─────────────────────────────────────────────────────────────

  it('filters by botId — matches bot: and pair: scopes for that agent', async () => {
    await insertFact(repo, { fact: 'alex bot fact', scope: 'bot:alex' });
    await insertFact(repo, {
      fact: 'alex pair fact',
      scope: 'pair:alex:dennis',
    });
    await insertFact(repo, { fact: 'riley bot fact', scope: 'bot:riley' });
    const { items, total } = await store.list(TEAM, { botId: 'alex' });
    expect(total).toBe(2);
    for (const item of items) expect(item.botId).toBe('alex');
  });

  it('botId filter does NOT over-match when botId contains underscores (starts_with vs LIKE safety)', async () => {
    // bot:a_b should NOT match botId=a (LIKE 'bot:a%' would, starts_with('bot:a:') does not)
    await insertFact(repo, { fact: 'underscore agent bot', scope: 'bot:a_b' });
    await insertFact(repo, {
      fact: 'underscore agent pair',
      scope: 'pair:a_b:dennis',
    });
    await insertFact(repo, { fact: 'exact agent bot', scope: 'bot:a' });

    // Filter by botId='a' — must only return bot:a, not bot:a_b or pair:a_b:*
    const { items } = await store.list(TEAM, { botId: 'a' });
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe('exact agent bot');
  });

  it('botId filter works correctly when the botId itself contains underscores', async () => {
    await insertFact(repo, { fact: 'underscore bot fact', scope: 'bot:a_b' });
    await insertFact(repo, {
      fact: 'underscore pair fact',
      scope: 'pair:a_b:dennis',
    });
    await insertFact(repo, { fact: 'other agent fact', scope: 'bot:riley' });

    const { items, total } = await store.list(TEAM, { botId: 'a_b' });
    expect(total).toBe(2);
    for (const item of items) expect(item.botId).toBe('a_b');
  });

  // ── assertedBy filter ────────────────────────────────────────────────────────

  it('filters by assertedBy', async () => {
    await insertFact(repo, {
      fact: 'dennis said',
      scope: 'team:local',
      assertedBy: 'dennis',
    });
    await insertFact(repo, {
      fact: 'sam said',
      scope: 'team:local',
      assertedBy: 'sam',
    });
    const { items } = await store.list(TEAM, { assertedBy: 'dennis' });
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe('dennis said');
  });

  // ── text search ───────────────────────────────────────────────────────────────

  it('filters by q (case-insensitive substring)', async () => {
    await insertFact(repo, {
      fact: 'Alex prefers TypeScript',
      scope: 'team:local',
    });
    await insertFact(repo, { fact: 'Riley uses React', scope: 'team:local' });
    const { items } = await store.list(TEAM, { q: 'typescript' });
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe('Alex prefers TypeScript');
  });

  it('q with a literal underscore does NOT act as a wildcard', async () => {
    await insertFact(repo, { fact: 'underscore_in_fact', scope: 'team:local' });
    await insertFact(repo, { fact: 'no match here', scope: 'team:local' });
    // Searching for 'underscore_in_fact' should match only the exact fact, not 'no match here'
    const { items } = await store.list(TEAM, { q: 'underscore_in_fact' });
    expect(items).toHaveLength(1);
    // Searching for 'underscore_in' with literal underscore — should NOT match 'no match here'
    // via LIKE-wildcard expansion
    const { total } = await store.list(TEAM, { q: 'underscore_in' });
    expect(total).toBe(1);
  });

  // ── pagination ────────────────────────────────────────────────────────────────

  it('paginates correctly — total reflects the full count, items respects limit/offset', async () => {
    for (let i = 0; i < 5; i++) {
      await insertFact(repo, { fact: `fact ${i}`, scope: 'team:local' });
    }
    const page1 = await store.list(TEAM, { limit: 2, offset: 0 });
    expect(page1.total).toBe(5);
    expect(page1.items).toHaveLength(2);
    expect(page1.limit).toBe(2);
    expect(page1.offset).toBe(0);

    const page2 = await store.list(TEAM, { limit: 2, offset: 2 });
    expect(page2.total).toBe(5);
    expect(page2.items).toHaveLength(2);

    const page3 = await store.list(TEAM, { limit: 2, offset: 4 });
    expect(page3.total).toBe(5);
    expect(page3.items).toHaveLength(1);
  });

  it('caps limit at 200', async () => {
    const { limit } = await store.list(TEAM, { limit: 999 });
    expect(limit).toBe(200);
  });

  // ── response shape ────────────────────────────────────────────────────────────

  it('returns all required FactView fields and no embedding', async () => {
    await insertFact(repo, {
      fact: 'Alex is the backend engineer',
      scope: 'pair:alex:dennis',
    });
    const { items } = await store.list(TEAM);
    const item = items[0];
    expect(item.id).toBeGreaterThan(0);
    expect(item).toMatchObject({
      content: 'Alex is the backend engineer',
      tier: 'private',
      botId: 'alex',
      humanId: 'dennis',
      projectId: null,
      confidence: 1.0,
      deletedAt: null,
    });
    expect(typeof item.createdAt).toBe('string');
    expect(typeof item.updatedAt).toBe('string');
    expect(Object.keys(item)).not.toContain('embedding');
    expect(Object.keys(item)).not.toContain('scope');
  });

  // ── get (single fact) ─────────────────────────────────────────────────────────

  it('get returns the fact by id', async () => {
    const id = await insertFact(repo, {
      fact: 'specific fact',
      scope: 'bot:alex',
    });
    const fact = await store.get(TEAM, id);
    expect(fact).not.toBeNull();
    expect(fact?.content).toBe('specific fact');
    expect(fact?.tier).toBe('bot');
  });

  it('get includes soft-deleted facts (admin can inspect forgotten facts by id)', async () => {
    const id = await insertFact(repo, {
      fact: 'forgotten',
      scope: 'team:local',
      deletedAt: new Date(),
    });
    const fact = await store.get(TEAM, id);
    expect(fact).not.toBeNull();
    expect(fact?.deletedAt).not.toBeNull();
  });

  it('get returns null for a wrong tenant', async () => {
    const id = await insertFact(repo, {
      fact: 'team-a fact',
      scope: 'team:local',
      teamId: 'team-a',
    });
    expect(await store.get('team-b', id)).toBeNull();
  });

  it('get returns null for a non-existent id', async () => {
    expect(await store.get(TEAM, 99999)).toBeNull();
  });
});
