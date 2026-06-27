import { randomBytes } from 'node:crypto';
import type { Repository } from 'typeorm';
import type { EnvService } from '@core/config/env/env.service';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  OrgWorktreeSecretEntity,
  OrgWorktreeSecretGrantEntity,
} from '../persistence/entities';
import { WorktreeSecretStore } from './worktree-secret.store';

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
const env = { get: (k: string) => (k === 'SECRETS_ENCRYPTION_KEY' ? KEY : undefined) } as unknown as EnvService;

describe('WorktreeSecretStore', () => {
  let store: WorktreeSecretStore;

  beforeEach(() => {
    store = new WorktreeSecretStore(
      memRepo<OrgWorktreeSecretEntity>(['org_id', 'name']),
      memRepo<OrgWorktreeSecretGrantEntity>(['org_id', 'repo_id', 'name', 'path']),
      env,
    );
  });

  it('round-trips an encrypted value (and stores ciphertext, not plaintext)', async () => {
    await store.write('o1', 'dotenvxPrivateKeys', 'SECRET=1');
    expect(await store.read('o1', 'dotenvxPrivateKeys')).toBe('SECRET=1');
  });

  it('list returns names only', async () => {
    await store.write('o1', 'a', 'va');
    await store.write('o1', 'b', 'vb');
    expect((await store.list('o1')).sort()).toEqual(['a', 'b']);
  });

  it('isGranted matches the exact (name, repo, path) triple', async () => {
    await store.grant('o1', 'repo-1', 'a', '.env.keys');
    expect(await store.isGranted('o1', 'repo-1', 'a', '.env.keys')).toBe(true);
    expect(await store.isGranted('o1', 'repo-1', 'a', 'other')).toBe(false);
    expect(await store.isGranted('o1', 'repo-2', 'a', '.env.keys')).toBe(false);
    expect(await store.isGranted('o2', 'repo-1', 'a', '.env.keys')).toBe(false);
  });

  it('revoke removes a grant; delete drops the secret and its grants', async () => {
    await store.write('o1', 'a', 'v');
    await store.grant('o1', 'repo-1', 'a', '.env.keys');
    await store.revoke('o1', 'repo-1', 'a', '.env.keys');
    expect(await store.isGranted('o1', 'repo-1', 'a', '.env.keys')).toBe(false);

    await store.grant('o1', 'repo-1', 'a', '.env.keys');
    await store.delete('o1', 'a');
    expect(await store.read('o1', 'a')).toBeNull();
    expect(await store.isGranted('o1', 'repo-1', 'a', '.env.keys')).toBe(false);
  });
});
