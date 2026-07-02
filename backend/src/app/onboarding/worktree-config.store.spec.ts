import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgWorktreeMountEntity, OrgWorktreeSeedEntity } from '../persistence/entities';
import { WorktreeConfigStore } from './worktree-config.store';

/** A tiny in-memory stand-in for a TypeORM repository (composite-key find/save/delete). */
function memRepo<T extends object>(keys: (keyof T)[]): Repository<T> {
  let rows: T[] = [];
  const match = (where: Partial<T>) => (r: T) =>
    (Object.entries(where) as [keyof T, unknown][]).every(([k, v]) => r[k] === v);
  return {
    create: (v: Partial<T>) => ({ ...v }) as T,
    find: async ({ where }: { where?: Partial<T> } = {}) =>
      where ? rows.filter(match(where)) : rows,
    findOne: async ({ where }: { where: Partial<T> }) => rows.find(match(where)) ?? null,
    save: async (row: T) => {
      rows = rows.filter((r) => !keys.every((k) => r[k] === row[k]));
      rows.push(row);
      return row;
    },
    delete: async (where: Partial<T>) => {
      rows = rows.filter((r) => !match(where)(r));
      return { affected: 0, raw: [] };
    },
  } as unknown as Repository<T>;
}

const ORG = 'org-1';
const REPO = 'repo-1';

describe('WorktreeConfigStore', () => {
  let store: WorktreeConfigStore;

  beforeEach(() => {
    store = new WorktreeConfigStore(
      memRepo<OrgWorktreeMountEntity>(['org_id', 'repo_id', 'path']),
      memRepo<OrgWorktreeSeedEntity>(['org_id', 'repo_id', 'path']),
    );
  });

  it('upsertMount is idempotent and upserts by path (never duplicates, replaces mode)', async () => {
    await store.upsertMount(ORG, REPO, '.cocoindex', 'per-thread');
    await store.upsertMount(ORG, REPO, '.cocoindex', 'per-thread');
    expect(await store.listMounts(ORG, REPO)).toEqual([{ path: '.cocoindex', mode: 'per-thread' }]);

    await store.upsertMount(ORG, REPO, '.cocoindex', 'shared-ro');
    expect(await store.listMounts(ORG, REPO)).toEqual([{ path: '.cocoindex', mode: 'shared-ro' }]);
  });

  it('removeMount drops exactly that mount', async () => {
    await store.upsertMount(ORG, REPO, 'a', 'per-thread');
    await store.upsertMount(ORG, REPO, 'b', 'per-thread');
    await store.removeMount(ORG, REPO, 'a');
    expect(await store.listMounts(ORG, REPO)).toEqual([{ path: 'b', mode: 'per-thread' }]);
  });

  it('addSeed is idempotent (no duplicates)', async () => {
    await store.addSeed(ORG, REPO, '.env.local');
    await store.addSeed(ORG, REPO, '.env.local');
    expect(await store.listSeed(ORG, REPO)).toEqual(['.env.local']);
  });

  it('scopes mounts/seed by org+repo — another org/repo sees nothing', async () => {
    await store.upsertMount(ORG, REPO, 'a', 'per-thread');
    await store.addSeed(ORG, REPO, 's');
    expect(await store.listMounts('other-org', REPO)).toEqual([]);
    expect(await store.listMounts(ORG, 'other-repo')).toEqual([]);
    expect(await store.listSeed('other-org', REPO)).toEqual([]);
  });

  describe('importLegacyIfEmpty', () => {
    let wt: string;
    beforeEach(() => {
      wt = mkdtempSync(join(tmpdir(), 'atlas-config-import-'));
    });
    afterEach(() => rmSync(wt, { recursive: true, force: true }));

    it('imports from a legacy atlas.json when the DB is empty', async () => {
      writeFileSync(
        join(wt, 'atlas.json'),
        JSON.stringify({ mounts: [{ path: '.cocoindex', mode: 'per-thread' }], seed: ['.env.local'] }),
      );
      await store.importLegacyIfEmpty(ORG, REPO, wt);
      expect(await store.listMounts(ORG, REPO)).toEqual([{ path: '.cocoindex', mode: 'per-thread' }]);
      expect(await store.listSeed(ORG, REPO)).toEqual(['.env.local']);
    });

    it('no-ops when the DB already has rows, even if a legacy file exists', async () => {
      await store.upsertMount(ORG, REPO, 'existing', 'per-thread');
      writeFileSync(join(wt, 'atlas.json'), JSON.stringify({ mounts: [{ path: 'from-file', mode: 'per-thread' }] }));
      await store.importLegacyIfEmpty(ORG, REPO, wt);
      expect(await store.listMounts(ORG, REPO)).toEqual([{ path: 'existing', mode: 'per-thread' }]);
    });

    it('no-ops when the DB is empty and there is no legacy file', async () => {
      await store.importLegacyIfEmpty(ORG, REPO, wt);
      expect(await store.listMounts(ORG, REPO)).toEqual([]);
      expect(await store.listSeed(ORG, REPO)).toEqual([]);
    });
  });
});
