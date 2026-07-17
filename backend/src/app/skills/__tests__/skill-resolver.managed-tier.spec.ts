import type { EnvService } from '@core/config/env/env.service';
import type { Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceSkillEntity } from '../../persistence/entities';
import { SkillResolver } from '../skill-resolver.service';
import { WorkspaceSkillStore } from '../workspace-skill.store';

/** Minimal `EnvService` stub — none of these tests exercise `resolveReviewSkillsForThread`'s disk reads. */
const fakeEnv = { get: () => undefined } as unknown as EnvService;

// Stubs the system-tier registry so this file can assert the MERGE/precedence behavior without depending
// on whatever's actually shipped in `system-skill-registry.ts` (which ships empty by design — see its
// spec). vi.mock is hoisted above these imports by vitest, so `SkillResolver` sees the stub.
vi.mock('./system-skill-registry', () => ({
  buildSystemSkills: () => [
    {
      name: 'shared',
      description: 'managed description',
      surfaces: ['build', 'brain'],
    },
    {
      name: 'managed-only',
      description: 'only on the system tier',
      surfaces: ['build'],
    },
    {
      name: 'git-shared',
      description: 'git-sourced managed description',
      surfaces: ['build'],
      git: {
        url: 'https://github.com/example/repo',
        subpath: 'skills/git-shared',
        ref: 'main',
      },
    },
  ],
}));

/** Minimal in-memory repository (only the methods the store calls) — same fixture as
 *  `skill-resolver.service.spec.ts`, duplicated here so this file's `vi.mock` stays self-contained. */
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
  async findOne({
    where,
  }: {
    where: Partial<WorkspaceSkillEntity>;
  }): Promise<WorkspaceSkillEntity | null> {
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
    return Object.entries(where).every(
      ([k, v]) => (r as unknown as Record<string, unknown>)[k] === v,
    );
  }
}

function make(): { resolver: SkillResolver; store: WorkspaceSkillStore } {
  const repo = new FakeRepo();
  const store = new WorkspaceSkillStore(repo as unknown as Repository<WorkspaceSkillEntity>);
  return { resolver: new SkillResolver(store, fakeEnv), store };
}

describe('SkillResolver.resolveForTurn — managed (system) tier precedence', () => {
  it('a managed skill composes when no org/repo skill of that name exists', async () => {
    const { resolver } = make();
    const out = await resolver.resolveForTurn('org1', 'repo-1', 'build');
    expect(out).toEqual(
      expect.arrayContaining([
        {
          name: 'shared',
          description: 'managed description',
          dirPath: 'shared',
          managed: true,
          reviewForTypes: [],
          reviewForGlobs: [],
        },
        {
          name: 'managed-only',
          description: 'only on the system tier',
          dirPath: 'managed-only',
          managed: true,
          reviewForTypes: [],
          reviewForGlobs: [],
        },
      ]),
    );
  });

  it('an org-scoped skill of the SAME name overrides the managed one (base layer, not the last word)', async () => {
    const { resolver, store } = make();
    await store.write('org1', '*', 'shared', { description: 'org override' });
    const out = await resolver.resolveForTurn('org1', 'repo-1', 'build');
    const shared = out.find((s) => s.name === 'shared');
    expect(shared).toEqual({
      name: 'shared',
      description: 'org override',
      dirPath: 'shared',
      reviewForTypes: [],
      reviewForGlobs: [],
    });
    expect(shared?.managed).toBeUndefined();
  });

  it('a repo-scoped skill of the same name ALSO overrides the managed one', async () => {
    const { resolver, store } = make();
    await store.write('org1', 'repo-1', 'shared', {
      description: 'repo override',
    });
    const out = await resolver.resolveForTurn('org1', 'repo-1', 'build');
    expect(out.find((s) => s.name === 'shared')).toEqual({
      name: 'shared',
      description: 'repo override',
      dirPath: 'repos/repo-1/shared',
      reviewForTypes: [],
      reviewForGlobs: [],
    });
  });

  it('filters the system tier by surface, same as the workspace tier', async () => {
    const { resolver } = make();
    const out = await resolver.resolveForTurn('org1', 'repo-1', 'review');
    expect(out.map((s) => s.name)).toEqual([]);
  });

  it('a git-sourced managed entry composes with managedGit: true, dirPath relative to the git-managed root', async () => {
    const { resolver } = make();
    const out = await resolver.resolveForTurn('org1', 'repo-1', 'build');
    expect(out).toEqual(
      expect.arrayContaining([
        {
          name: 'git-shared',
          description: 'git-sourced managed description',
          dirPath: 'git-shared',
          managedGit: true,
          reviewForTypes: [],
          reviewForGlobs: [],
        },
      ]),
    );
  });

  it('an org-scoped skill overrides a git-sourced managed one by name, same as a static one', async () => {
    const { resolver, store } = make();
    await store.write('org1', '*', 'git-shared', {
      description: 'org override',
    });
    const out = await resolver.resolveForTurn('org1', 'repo-1', 'build');
    const gitShared = out.find((s) => s.name === 'git-shared');
    expect(gitShared).toEqual({
      name: 'git-shared',
      description: 'org override',
      dirPath: 'git-shared',
      reviewForTypes: [],
      reviewForGlobs: [],
    });
    expect(gitShared?.managed).toBeUndefined();
    expect(gitShared?.managedGit).toBeUndefined();
  });
});
