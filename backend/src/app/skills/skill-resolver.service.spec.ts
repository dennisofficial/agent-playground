import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Repository } from 'typeorm';
import type { EnvService } from '@core/config/env/env.service';
import type { WorkspaceSkillEntity } from '../persistence/entities';
import { SkillResolver } from './skill-resolver.service';
import { WorkspaceSkillStore } from './workspace-skill.store';

/** Minimal `EnvService` stub — none of these tests exercise `resolveReviewSkillsForThread`'s disk reads. */
const fakeEnv = { get: () => undefined } as unknown as EnvService;

// This file tests the ORG/REPO tier in isolation from whatever `system-skill-registry.ts` actually ships
// (real content since P5+#14) — an empty system tier here, exactly like `skill-resolver.managed-tier.spec.ts`
// stubs it for the OPPOSITE reason (to test the system tier's own precedence behavior). `vi.mock` is
// hoisted above these imports by vitest.
vi.mock('./system-skill-registry', () => ({ buildSystemSkills: () => [] }));

/** Minimal in-memory repository (only the methods the store calls). */
class FakeRepo {
  rows: WorkspaceSkillEntity[] = [];
  create(p: Partial<WorkspaceSkillEntity>): WorkspaceSkillEntity {
    return { ...p } as WorkspaceSkillEntity;
  }
  async save(row: WorkspaceSkillEntity): Promise<WorkspaceSkillEntity> {
    const i = this.rows.findIndex(
      (r) => r.org_id === row.org_id && r.scope === row.scope && r.name === row.name,
    );
    if (i >= 0) this.rows[i] = row;
    else this.rows.push(row);
    return row;
  }
  async findOne({ where }: { where: Partial<WorkspaceSkillEntity> }): Promise<WorkspaceSkillEntity | null> {
    return this.rows.find((r) => this.match(r, where)) ?? null;
  }
  async find({
    where,
  }: {
    where: Partial<WorkspaceSkillEntity> | Partial<WorkspaceSkillEntity>[];
  }): Promise<WorkspaceSkillEntity[]> {
    const conds = Array.isArray(where) ? where : [where];
    return this.rows.filter((r) => conds.some((c) => this.match(r, c)));
  }
  async delete(): Promise<void> {}
  private match(r: WorkspaceSkillEntity, where: Partial<WorkspaceSkillEntity>): boolean {
    return Object.entries(where).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v);
  }
}

function make(): { resolver: SkillResolver; store: WorkspaceSkillStore } {
  const repo = new FakeRepo();
  const store = new WorkspaceSkillStore(repo as unknown as Repository<WorkspaceSkillEntity>);
  return { resolver: new SkillResolver(store, fakeEnv), store };
}

describe('SkillResolver.resolveForTurn', () => {
  let resolver: SkillResolver;
  let store: WorkspaceSkillStore;
  beforeEach(() => {
    ({ resolver, store } = make());
  });

  it('returns [] when the org has no skills', async () => {
    expect(await resolver.resolveForTurn('org1', 'repo-1', 'build')).toEqual([]);
  });

  it('a repo-scoped skill OVERRIDES an org-scoped skill of the same name', async () => {
    await store.write('org1', '*', 'migrations', { description: 'org' });
    await store.write('org1', 'repo-1', 'migrations', { description: 'repo' });
    const out = await resolver.resolveForTurn('org1', 'repo-1', 'build');
    expect(out).toHaveLength(1);
    expect(out[0].description).toBe('repo');
    // repo-scoped → dirPath nests under repos/<repoId>/<name>, not the org-scoped `<name>` shape.
    expect(out[0].dirPath).toBe('repos/repo-1/migrations');
  });

  it('org-scoped skills apply to a repo that has no override of that name', async () => {
    await store.write('org1', '*', 'shared', { description: 'd' });
    const out = await resolver.resolveForTurn('org1', 'repo-9', 'build');
    expect(out.map((s) => s.name)).toEqual(['shared']);
    expect(out[0].dirPath).toBe('shared');
  });

  it('filters by surface (default surfaces is build-only)', async () => {
    await store.write('org1', '*', 'buildonly', { description: 'd' });
    expect(await resolver.resolveForTurn('org1', 'repo-1', 'brain')).toEqual([]);
    expect((await resolver.resolveForTurn('org1', 'repo-1', 'build')).map((s) => s.name)).toEqual([
      'buildonly',
    ]);
  });

  it('excludes disabled skills', async () => {
    await store.write('org1', '*', 'off', { description: 'd', enabled: false });
    expect(await resolver.resolveForTurn('org1', 'repo-1', 'build')).toEqual([]);
  });

  it('returns name/description/dirPath (plain data, no secrets or file content)', async () => {
    await store.write('org1', '*', 'k', { description: 'Use when X', surfaces: ['brain'] });
    const [s] = await resolver.resolveForTurn('org1', 'repo-1', 'brain');
    expect(s).toEqual({
      name: 'k',
      description: 'Use when X',
      dirPath: 'k',
      reviewForTypes: [],
      reviewForGlobs: [],
    });
  });
});
