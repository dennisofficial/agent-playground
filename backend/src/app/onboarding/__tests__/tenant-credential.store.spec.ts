import type { EnvService } from '@core/config/env/env.service';
import type { DataSource, Repository } from 'typeorm';
import { describe, expect, it } from 'vitest';
import type { OrganizationEntity, OrgCredentialsEntity } from '../../persistence/entities';
import { TenantCredentialStore } from '../tenant-credential.store';

const KEY = Buffer.alloc(32, 9).toString('base64');

function fakeEnv(map: Record<string, string | undefined>): EnvService {
  return { get: (k: string) => map[k] } as unknown as EnvService;
}

/**
 * One in-memory `rows` store shared by BOTH a fake Repository (used by `read`/`write`/`presence`) and a
 * fake DataSource whose `transaction` runs the callback with a fake EntityManager (used by
 * `advanceCodexAuthSecret`). The pessimistic lock is a no-op here — this covers the guard LOGIC; true
 * lock atomicity is a Postgres guarantee exercised in real runs. `orgs` backs `dataSource.getRepository
 * (OrganizationEntity)`, which `presence()` reads for the selected-claude-credential pointer.
 */
function fakeDb(): {
  repo: Repository<OrgCredentialsEntity>;
  dataSource: DataSource;
  orgs: Map<string, OrganizationEntity>;
} {
  const rows = new Map<string, OrgCredentialsEntity>();
  const orgs = new Map<string, OrganizationEntity>();
  const k = (t: string, s: string): string => `${t} ${s}`;
  const findOne = ({ where }: { where: { org_id: string; scope: string } }) =>
    rows.get(k(where.org_id, where.scope)) ?? null;
  const save = (row: OrgCredentialsEntity) => {
    rows.set(k(row.org_id, row.scope ?? '*'), row);
    return row;
  };
  const repo = {
    async findOne(opts: { where: { org_id: string; scope: string } }) {
      return findOne(opts);
    },
    create(partial: Partial<OrgCredentialsEntity>) {
      return { ...partial } as OrgCredentialsEntity;
    },
    async save(row: OrgCredentialsEntity) {
      return save(row);
    },
  } as unknown as Repository<OrgCredentialsEntity>;
  const manager = {
    async findOne(_entity: unknown, opts: { where: { org_id: string; scope: string } }) {
      return findOne(opts);
    },
    async save(row: OrgCredentialsEntity) {
      return save(row);
    },
  };
  const dataSource = {
    async transaction(fn: (m: typeof manager) => Promise<unknown>) {
      return fn(manager);
    },
    getRepository() {
      return {
        async findOne({ where }: { where: { id: string } }) {
          return orgs.get(where.id) ?? null;
        },
      };
    },
  } as unknown as DataSource;
  return { repo, dataSource, orgs };
}

function makeStore(
  env: Record<string, string | undefined> = { SECRETS_ENCRYPTION_KEY: KEY },
  orgSeed?: Record<string, string | null>,
) {
  const { repo, dataSource, orgs } = fakeDb();
  for (const [orgId, selectedId] of Object.entries(orgSeed ?? {})) {
    orgs.set(orgId, {
      id: orgId,
      selected_claude_credential_id: selectedId,
    } as OrganizationEntity);
  }
  return new TenantCredentialStore(repo, dataSource, fakeEnv(env));
}

/** A minimal Codex `auth.json` carrying a top-level `last_refresh` (what the monotonic guard reads). */
function codexBlob(lastRefresh: string, tag = 'x'): string {
  return JSON.stringify({
    last_refresh: lastRefresh,
    tokens: { id_token: 'i', access_token: tag },
  });
}

function fakeCodexAuthJson(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return JSON.stringify({ tokens: { id_token: `${header}.${payload}.sig` } });
}

describe('TenantCredentialStore', () => {
  it('round-trips secrets (encrypt on write, decrypt on read)', async () => {
    const store = makeStore();
    await store.write('T1', {
      anthropicApiKey: 'sk-ant-1',
      githubPat: 'ghp_1',
      claudeOauthToken: 'sk-ant-oat-1',
      codexAuthSecret: 'codex-1',
    });
    const creds = await store.read('T1');
    expect(creds?.anthropicApiKey).toBe('sk-ant-1');
    expect(creds?.githubPat).toBe('ghp_1');
    expect(creds?.claudeOauthToken).toBe('sk-ant-oat-1');
    expect(creds?.codexAuthSecret).toBe('codex-1');
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
      hasGithubApp: false,
      githubAuthMode: 'pat',
      engineAuthSet: false, // no Claude subscription token → harness auth not satisfied
      hasCodex: false,
    });
  });

  it('engineAuthSet reflects a SELECTED claude credential, not the legacy column', async () => {
    const store = makeStore(undefined, { T1: null });
    await store.write('T1', {
      anthropicApiKey: 'a1',
      claudeOauthToken: 'oauth',
    });
    // The legacy column is set but no `claude_credentials` row is selected — still unsatisfied.
    expect((await store.presence('T1')).engineAuthSet).toBe(false);

    const selected = makeStore(undefined, { T1: 'cred-1' });
    await selected.write('T1', { anthropicApiKey: 'a1' });
    expect((await selected.presence('T1')).engineAuthSet).toBe(true);
  });

  it('refuses to write without an encryption key', async () => {
    const store = makeStore({ SECRETS_ENCRYPTION_KEY: undefined });
    await expect(store.write('T1', { anthropicApiKey: 'x' })).rejects.toThrow(
      /SECRETS_ENCRYPTION_KEY is not set/,
    );
  });

  describe('codexAccountEmail', () => {
    it('decrypts the stored Codex auth.json and decodes the account email', async () => {
      const store = makeStore();
      await store.write('T1', {
        codexAuthSecret: fakeCodexAuthJson({ email: 'codex@example.com' }),
      });

      await expect(store.codexAccountEmail('T1')).resolves.toBe('codex@example.com');
    });

    it('returns undefined for API-key-only blobs and missing Codex credentials', async () => {
      const store = makeStore();
      await expect(store.codexAccountEmail('missing')).resolves.toBeUndefined();

      await store.write('T1', {
        codexAuthSecret: JSON.stringify({ apiKey: 'sk-123' }),
      });
      await expect(store.codexAccountEmail('T1')).resolves.toBeUndefined();
    });
  });

  describe('advanceCodexAuthSecret (atomic monotonic write-back)', () => {
    it('advances to a blob with a NEWER last_refresh', async () => {
      const store = makeStore();
      await store.write('T1', {
        codexAuthSecret: codexBlob('2026-07-01T00:00:00.000Z'),
      });
      const next = codexBlob('2026-07-02T00:00:00.000Z', 'newer');
      await store.advanceCodexAuthSecret('T1', next);
      expect((await store.read('T1'))?.codexAuthSecret).toBe(next);
    });

    it('SKIPS a blob with an OLDER last_refresh (never clobbers a newer credential)', async () => {
      const store = makeStore();
      const current = codexBlob('2026-07-02T00:00:00.000Z', 'current');
      await store.write('T1', { codexAuthSecret: current });
      await store.advanceCodexAuthSecret('T1', codexBlob('2026-07-01T00:00:00.000Z', 'stale'));
      expect((await store.read('T1'))?.codexAuthSecret).toBe(current);
    });

    it('SKIPS an equal last_refresh', async () => {
      const store = makeStore();
      const current = codexBlob('2026-07-02T00:00:00.000Z', 'current');
      await store.write('T1', { codexAuthSecret: current });
      await store.advanceCodexAuthSecret(
        'T1',
        codexBlob('2026-07-02T00:00:00.000Z', 'sametime-different'),
      );
      expect((await store.read('T1'))?.codexAuthSecret).toBe(current);
    });

    it('when timestamps are absent, writes only on a real change', async () => {
      const store = makeStore();
      const current = JSON.stringify({ tokens: { access_token: 'a' } }); // no last_refresh
      await store.write('T1', { codexAuthSecret: current });
      // identical → no-op
      await store.advanceCodexAuthSecret('T1', current);
      expect((await store.read('T1'))?.codexAuthSecret).toBe(current);
      // changed → written
      const changed = JSON.stringify({ tokens: { access_token: 'b' } });
      await store.advanceCodexAuthSecret('T1', changed);
      expect((await store.read('T1'))?.codexAuthSecret).toBe(changed);
    });

    it('no-ops when the org has no credentials row', async () => {
      const store = makeStore();
      await store.advanceCodexAuthSecret('ghost', codexBlob('2026-07-02T00:00:00.000Z'));
      expect(await store.read('ghost')).toBeNull();
    });

    it('invalidates the read cache after an advance', async () => {
      const store = makeStore();
      const v1 = codexBlob('2026-07-01T00:00:00.000Z', 'v1');
      await store.write('T1', { codexAuthSecret: v1 });
      expect((await store.read('T1'))?.codexAuthSecret).toBe(v1); // populate cache
      const v2 = codexBlob('2026-07-02T00:00:00.000Z', 'v2');
      await store.advanceCodexAuthSecret('T1', v2);
      expect((await store.read('T1'))?.codexAuthSecret).toBe(v2); // cache busted → sees v2
    });
  });

  describe('mergeClaudeUsageWindow (credential-scoped snapshot)', () => {
    it('RESETS windows when the incoming credentialId differs from the stored one', async () => {
      const store = makeStore();
      await store.write('T1', { anthropicApiKey: 'a1' });
      const resetsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await store.mergeClaudeUsageWindow(
        'T1',
        'fiveHour',
        { utilization: 100, resetsAt },
        Date.now(),
        'credA',
      );
      await store.mergeClaudeUsageWindow(
        'T1',
        'sevenDay',
        { utilization: 50, resetsAt },
        Date.now(),
        'credA',
      );
      let snapshot = await store.readClaudeUsageSnapshot('T1');
      expect(snapshot?.credentialId).toBe('credA');
      expect(snapshot?.windows.fiveHour).toBeDefined();
      expect(snapshot?.windows.sevenDay).toBeDefined();

      // A harvest from a DIFFERENT credential resets the snapshot — the account-A windows are gone.
      await store.mergeClaudeUsageWindow(
        'T1',
        'fiveHour',
        { utilization: 21, resetsAt },
        Date.now(),
        'credB',
      );
      snapshot = await store.readClaudeUsageSnapshot('T1');
      expect(snapshot?.credentialId).toBe('credB');
      expect(snapshot?.windows.fiveHour).toEqual({ utilization: 21, resetsAt });
      expect(snapshot?.windows.sevenDay).toBeUndefined();
    });

    it('an untagged legacy snapshot is replaced by the first tagged harvest', async () => {
      const store = makeStore();
      await store.write('T1', { anthropicApiKey: 'a1' });
      const resetsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await store.mergeClaudeUsageWindow(
        'T1',
        'fiveHour',
        { utilization: 100, resetsAt },
        Date.now(),
      );
      expect((await store.readClaudeUsageSnapshot('T1'))?.credentialId).toBeUndefined();

      await store.mergeClaudeUsageWindow(
        'T1',
        'fiveHour',
        { utilization: 5, resetsAt },
        Date.now(),
        'credA',
      );
      const snapshot = await store.readClaudeUsageSnapshot('T1');
      expect(snapshot?.credentialId).toBe('credA');
      expect(snapshot?.windows.fiveHour).toEqual({ utilization: 5, resetsAt });
    });
  });
});
