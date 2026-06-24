import { describe, expect, it } from 'vitest';
import type { EnvService } from '@core/config/env/env.service';
import type { Repository } from 'typeorm';
import type { OrgCredentialsEntity } from '../persistence/entities';
import { TenantCredentialStore } from './tenant-credential.store';

const KEY = Buffer.alloc(32, 9).toString('base64');

function fakeEnv(map: Record<string, string | undefined>): EnvService {
  return { get: (k: string) => map[k] } as unknown as EnvService;
}

/** A minimal in-memory Repository<OrgCredentialsEntity> keyed by (org_id, scope). */
function fakeRepo(): Repository<OrgCredentialsEntity> {
  const rows = new Map<string, OrgCredentialsEntity>();
  const k = (t: string, s: string): string => `${t} ${s}`;
  return {
    async findOne({ where }: { where: { org_id: string; scope: string } }) {
      return rows.get(k(where.org_id, where.scope)) ?? null;
    },
    create(partial: Partial<OrgCredentialsEntity>) {
      return { ...partial } as OrgCredentialsEntity;
    },
    async save(row: OrgCredentialsEntity) {
      rows.set(k(row.org_id, row.scope ?? '*'), row);
      return row;
    },
  } as unknown as Repository<OrgCredentialsEntity>;
}

function makeStore(env: Record<string, string | undefined> = { SECRETS_ENCRYPTION_KEY: KEY }) {
  return new TenantCredentialStore(fakeRepo(), fakeEnv(env));
}

describe('TenantCredentialStore', () => {
  it('round-trips secrets (encrypt on write, decrypt on read)', async () => {
    const store = makeStore();
    await store.write('T1', { anthropicApiKey: 'sk-ant-1', githubPat: 'ghp_1' });
    const creds = await store.read('T1');
    expect(creds?.anthropicApiKey).toBe('sk-ant-1');
    expect(creds?.githubPat).toBe('ghp_1');
    expect(creds?.engineAuthMode).toBe('api_key');
  });

  it('returns null for a team with no row', async () => {
    expect(await makeStore().read('nobody')).toBeNull();
  });

  it('merges partial patches (only provided fields change)', async () => {
    const store = makeStore();
    await store.write('T1', { anthropicApiKey: 'a1' });
    await store.write('T1', { githubPat: 'g1' }); // must not wipe the anthropic key
    const creds = await store.read('T1');
    expect(creds?.anthropicApiKey).toBe('a1');
    expect(creds?.githubPat).toBe('g1');
  });

  it('invalidates the read cache on write', async () => {
    const store = makeStore();
    await store.write('T1', { anthropicApiKey: 'a1' });
    expect((await store.read('T1'))?.anthropicApiKey).toBe('a1'); // populates cache
    await store.write('T1', { anthropicApiKey: 'a2' });
    expect((await store.read('T1'))?.anthropicApiKey).toBe('a2'); // cache busted
  });

  it('presence() reports flags without decrypting (works without a key)', async () => {
    const store = makeStore();
    await store.write('T1', { anthropicApiKey: 'a1' });
    // A fresh store over the SAME data but WITHOUT a key still answers presence.
    const presence = await store.presence('T1');
    expect(presence).toEqual({
      hasAnthropic: true,
      hasOpenai: false,
      hasGithub: false,
      engineAuthSet: true, // api_key mode + anthropic key present
    });
  });

  it('subscription engineAuthSet requires a subscription secret', async () => {
    const store = makeStore();
    await store.write('T1', { engineAuthMode: 'subscription' });
    expect((await store.presence('T1')).engineAuthSet).toBe(false);
    await store.write('T1', { engineAuthSecret: 'oauth' });
    expect((await store.presence('T1')).engineAuthSet).toBe(true);
  });

  it('refuses to write without an encryption key', async () => {
    const store = makeStore({ SECRETS_ENCRYPTION_KEY: undefined });
    await expect(store.write('T1', { anthropicApiKey: 'x' })).rejects.toThrow(
      /SECRETS_ENCRYPTION_KEY is not set/,
    );
  });
});
