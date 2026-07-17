import type { EnvService } from '@core/config/env/env.service';
import { randomBytes } from 'node:crypto';
import type { Repository } from 'typeorm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { OrgWorkspaceSecretFileEntity } from '../persistence/entities';
import { WorkspaceSecretFileStore } from './workspace-secret.store';

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

const KEY = randomBytes(32).toString('hex');
const env = {
  get: (k: string) => (k === 'SECRETS_ENCRYPTION_KEY' ? KEY : undefined),
} as unknown as EnvService;

describe('WorkspaceSecretFileStore', () => {
  let store: WorkspaceSecretFileStore;

  beforeEach(() => {
    store = new WorkspaceSecretFileStore(
      memRepo<OrgWorkspaceSecretFileEntity>(['org_id', 'repo_id', 'path']),
      env,
    );
  });

  it('round-trips an encrypted value keyed by (org, repo, path)', async () => {
    await store.write('o1', 'repo-1', '.env.keys', 'SECRET=1', 'dotenvxPrivateKeys');
    expect(await store.read('o1', 'repo-1', '.env.keys')).toBe('SECRET=1');
    // Same path in another repo is a distinct row.
    expect(await store.read('o1', 'repo-2', '.env.keys')).toBeNull();
  });

  it('list returns file refs (repo + path + label), never values, optionally scoped to a repo', async () => {
    await store.write('o1', 'repo-1', '.env.keys', 'va', 'A');
    await store.write('o1', 'repo-1', 'server/sa.json', 'vb');
    await store.write('o1', 'repo-2', '.env', 'vc');

    const all = await store.list('o1');
    expect(all).toHaveLength(3);
    expect(all.every((f) => !('value' in f) && !('value_enc' in f))).toBe(true);

    const repo1 = await store.list('o1', 'repo-1');
    expect(repo1.map((f) => f.path).sort()).toEqual(['.env.keys', 'server/sa.json']);
    expect(repo1.find((f) => f.path === '.env.keys')?.label).toBe('A');
  });

  it('listForRepo yields path + version for the hydration sig (no values)', async () => {
    await store.write('o1', 'repo-1', '.env.keys', 'v');
    const versions = await store.listForRepo('o1', 'repo-1');
    expect(versions).toHaveLength(1);
    expect(versions[0].path).toBe('.env.keys');
    expect(typeof versions[0].updatedAt).toBe('number');
  });

  it('write upserts by (org, repo, path); delete drops just that file', async () => {
    await store.write('o1', 'repo-1', '.env.keys', 'v1');
    await store.write('o1', 'repo-1', '.env.keys', 'v2'); // same key → replace
    expect(await store.read('o1', 'repo-1', '.env.keys')).toBe('v2');
    expect(await store.list('o1', 'repo-1')).toHaveLength(1);

    await store.delete('o1', 'repo-1', '.env.keys');
    expect(await store.read('o1', 'repo-1', '.env.keys')).toBeNull();
    expect(await store.list('o1')).toHaveLength(0);
  });
});
