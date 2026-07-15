import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  OrgWorkspaceMountEntity,
  RepoEntity,
} from '../persistence/entities';
import { WorkspaceConfigStore } from './workspace-config.store';

/** A tiny in-memory stand-in for a TypeORM repository (composite-key find/save/update/delete). */
function memRepo<T extends object>(
  keys: (keyof T)[],
): Repository<T> & { rows: T[] } {
  let rows: T[] = [];
  const match = (where: Partial<T>) => (r: T) =>
    (Object.entries(where) as [keyof T, unknown][]).every(
      ([k, v]) => r[k] === v,
    );
  return {
    get rows() {
      return rows;
    },
    create: (v: Partial<T>) => ({ ...v }) as T,
    find: async ({ where }: { where?: Partial<T> } = {}) =>
      where ? rows.filter(match(where)) : rows,
    findOne: async ({ where }: { where: Partial<T> }) =>
      rows.find(match(where)) ?? null,
    save: async (row: T) => {
      rows = rows.filter((r) => !keys.every((k) => r[k] === row[k]));
      rows.push(row);
      return row;
    },
    update: async (where: Partial<T>, partial: Partial<T>) => {
      let affected = 0;
      rows = rows.map((r) =>
        match(where)(r) ? (affected++, { ...r, ...partial }) : r,
      );
      return { affected, raw: [] };
    },
    delete: async (where: Partial<T>) => {
      rows = rows.filter((r) => !match(where)(r));
      return { affected: 0, raw: [] };
    },
  } as unknown as Repository<T> & { rows: T[] };
}

const ORG = 'org-1';
const REPO = 'repo-1';

describe('WorkspaceConfigStore', () => {
  let store: WorkspaceConfigStore;
  let repos: Repository<RepoEntity> & { rows: RepoEntity[] };

  beforeEach(() => {
    repos = memRepo<RepoEntity>(['id']);
    store = new WorkspaceConfigStore(
      memRepo<OrgWorkspaceMountEntity>(['org_id', 'repo_id', 'path']),
      repos,
    );
  });

  it('upsertMount is idempotent and upserts by path (never duplicates, replaces mode)', async () => {
    await store.upsertMount(ORG, REPO, '.venv', 'per-thread');
    await store.upsertMount(ORG, REPO, '.venv', 'per-thread');
    expect(await store.listMounts(ORG, REPO)).toEqual([
      { path: '.venv', mode: 'per-thread' },
    ]);

    await store.upsertMount(ORG, REPO, '.venv', 'shared-ro');
    expect(await store.listMounts(ORG, REPO)).toEqual([
      { path: '.venv', mode: 'shared-ro' },
    ]);
  });

  it('removeMount drops exactly that mount', async () => {
    await store.upsertMount(ORG, REPO, 'a', 'per-thread');
    await store.upsertMount(ORG, REPO, 'b', 'per-thread');
    await store.removeMount(ORG, REPO, 'a');
    expect(await store.listMounts(ORG, REPO)).toEqual([
      { path: 'b', mode: 'per-thread' },
    ]);
  });

  it('scopes mounts by org+repo — another org/repo sees nothing', async () => {
    await store.upsertMount(ORG, REPO, 'a', 'per-thread');
    expect(await store.listMounts('other-org', REPO)).toEqual([]);
    expect(await store.listMounts(ORG, 'other-repo')).toEqual([]);
  });

  describe('setup script', () => {
    beforeEach(async () => {
      await repos.save({
        id: REPO,
        org_id: ORG,
        setup_script: null,
      } as RepoEntity);
    });

    it('round-trips get/set on repos.setup_script', async () => {
      expect(await store.getSetupScript(ORG, REPO)).toBeNull();
      await store.setSetupScript(ORG, REPO, 'pnpm install');
      expect(await store.getSetupScript(ORG, REPO)).toBe('pnpm install');
    });

    it('treats an empty / whitespace-only script as clearing it (null)', async () => {
      await store.setSetupScript(ORG, REPO, 'pnpm install');
      await store.setSetupScript(ORG, REPO, '   ');
      expect(await store.getSetupScript(ORG, REPO)).toBeNull();
      await store.setSetupScript(ORG, REPO, 'pnpm install');
      await store.setSetupScript(ORG, REPO, null);
      expect(await store.getSetupScript(ORG, REPO)).toBeNull();
    });

    it('returns null for an unknown repo', async () => {
      expect(await store.getSetupScript(ORG, 'nope')).toBeNull();
    });
  });

  describe('importLegacyIfEmpty', () => {
    let wt: string;
    beforeEach(() => {
      wt = mkdtempSync(join(tmpdir(), 'atlas-config-import-'));
    });
    afterEach(() => rmSync(wt, { recursive: true, force: true }));

    it('imports mounts from a legacy atlas.json when the DB is empty (a legacy seed[] is ignored)', async () => {
      writeFileSync(
        join(wt, 'atlas.json'),
        JSON.stringify({
          mounts: [{ path: '.venv', mode: 'per-thread' }],
          seed: ['.env.local'],
        }),
      );
      await store.importLegacyIfEmpty(ORG, REPO, wt);
      expect(await store.listMounts(ORG, REPO)).toEqual([
        { path: '.venv', mode: 'per-thread' },
      ]);
    });

    it('no-ops when the DB already has rows, even if a legacy file exists', async () => {
      await store.upsertMount(ORG, REPO, 'existing', 'per-thread');
      writeFileSync(
        join(wt, 'atlas.json'),
        JSON.stringify({ mounts: [{ path: 'from-file', mode: 'per-thread' }] }),
      );
      await store.importLegacyIfEmpty(ORG, REPO, wt);
      expect(await store.listMounts(ORG, REPO)).toEqual([
        { path: 'existing', mode: 'per-thread' },
      ]);
    });

    it('no-ops when the DB is empty and there is no legacy file', async () => {
      await store.importLegacyIfEmpty(ORG, REPO, wt);
      expect(await store.listMounts(ORG, REPO)).toEqual([]);
    });
  });
});
