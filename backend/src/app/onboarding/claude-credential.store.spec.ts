import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EnvService } from '@core/config/env/env.service';
import type { DataSource, Repository } from 'typeorm';
import type { OrganizationEntity, OrgClaudeCredentialEntity } from '../persistence/entities';
import { ClaudeCredentialStore } from './claude-credential.store';

const KEY = Buffer.alloc(32, 9).toString('base64');

function fakeEnv(map: Record<string, string | undefined>): EnvService {
  return { get: (k: string) => map[k] } as unknown as EnvService;
}

/**
 * In-memory `claude_credentials` + `organizations` rows shared by a fake Repository (used by the
 * non-transactional methods) and a fake DataSource whose `transaction` runs the callback with a fake
 * EntityManager (used by `advanceClaudeCredential` / `upsertLegacySetupToken`). The pessimistic lock is a
 * no-op here — this covers the guard LOGIC; true lock atomicity is a Postgres guarantee exercised in real
 * runs. Mirrors the fake-datasource idiom in `tenant-credential.store.spec.ts`.
 */
function fakeDb(): {
  repo: Repository<OrgClaudeCredentialEntity>;
  orgRepo: Repository<OrganizationEntity>;
  dataSource: DataSource;
  orgs: Map<string, OrganizationEntity>;
} {
  const rows = new Map<string, OrgClaudeCredentialEntity>();
  const orgs = new Map<string, OrganizationEntity>();

  const matches = (row: OrgClaudeCredentialEntity, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => (row as unknown as Record<string, unknown>)[k] === v);

  const findOne = (opts: { where: Record<string, unknown> }) =>
    [...rows.values()].find((r) => matches(r, opts.where)) ?? null;

  const find = (opts: { where: Record<string, unknown> }) =>
    [...rows.values()]
      .filter((r) => matches(r, opts.where))
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

  const create = (partial: Partial<OrgClaudeCredentialEntity>) => ({ ...partial }) as OrgClaudeCredentialEntity;

  const save = (row: OrgClaudeCredentialEntity) => {
    if (!row.id) row.id = randomUUID();
    if (!row.created_at) row.created_at = new Date();
    rows.set(row.id, row);
    return row;
  };

  const del = (where: { id: string; org_id: string }) => {
    const row = findOne({ where });
    if (row) rows.delete(row.id);
  };

  const repo = {
    async findOne(opts: { where: Record<string, unknown> }) {
      return findOne(opts);
    },
    async find(opts: { where: Record<string, unknown> }) {
      return find(opts);
    },
    create(partial: Partial<OrgClaudeCredentialEntity>) {
      return create(partial);
    },
    async save(row: OrgClaudeCredentialEntity) {
      return save(row);
    },
    async delete(where: { id: string; org_id: string }) {
      del(where);
    },
  } as unknown as Repository<OrgClaudeCredentialEntity>;

  const orgRepo = {
    async findOne(opts: { where: { id: string } }) {
      return orgs.get(opts.where.id) ?? null;
    },
    async update(criteria: { id: string }, partial: Partial<OrganizationEntity>) {
      const org = orgs.get(criteria.id);
      if (org) Object.assign(org, partial);
    },
  } as unknown as Repository<OrganizationEntity>;

  const manager = {
    async findOne(_entity: unknown, opts: { where: Record<string, unknown> }) {
      return findOne(opts);
    },
    create(_entity: unknown, partial: Partial<OrgClaudeCredentialEntity>) {
      return create(partial);
    },
    async save(row: OrgClaudeCredentialEntity) {
      return save(row);
    },
  };

  const dataSource = {
    async transaction(fn: (m: typeof manager) => Promise<unknown>) {
      return fn(manager);
    },
  } as unknown as DataSource;

  return { repo, orgRepo, dataSource, orgs };
}

function makeStore(env: Record<string, string | undefined> = { SECRETS_ENCRYPTION_KEY: KEY }) {
  const { repo, orgRepo, dataSource, orgs } = fakeDb();
  const store = new ClaudeCredentialStore(repo, orgRepo, dataSource, fakeEnv(env));
  return { store, orgs };
}

/** A minimal `claudeAiOauth` blob (what `isNewerClaudeCredential` reads via `expiresAt`). */
function oauthBlob(expiresAt: number, accessToken = 'access', refreshToken = 'refresh'): string {
  return JSON.stringify({ claudeAiOauth: { accessToken, refreshToken, expiresAt } });
}

describe('ClaudeCredentialStore', () => {
  it('createPersonal + setSelected + getSelectedDecrypted round-trips through the cipher', async () => {
    const { store, orgs } = makeStore();
    orgs.set('T1', { id: 'T1', selected_claude_credential_id: null } as OrganizationEntity);
    const id = await store.createPersonal('T1', {
      label: 'Dennis personal',
      accessToken: 'acc-1',
      refreshToken: 'ref-1',
      expiresAt: 1000,
      scopes: 'user:inference user:profile',
      subscriptionType: 'max',
      accountEmail: 'd@example.com',
    });
    await store.setSelected('T1', id);

    const sel = await store.getSelectedDecrypted('T1');
    expect(sel?.id).toBe(id);
    expect(sel?.kind).toBe('personal');
    expect(JSON.parse(sel!.secret)).toEqual({
      claudeAiOauth: {
        accessToken: 'acc-1',
        refreshToken: 'ref-1',
        expiresAt: 1000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
      },
    });
  });

  it('createSetupToken + setSelected + getSelectedDecrypted round-trips the raw token', async () => {
    const { store, orgs } = makeStore();
    orgs.set('T1', { id: 'T1', selected_claude_credential_id: null } as OrganizationEntity);
    const id = await store.createSetupToken('T1', { label: 'CI setup-token', token: 'sk-setup-1' });
    await store.setSelected('T1', id);

    const sel = await store.getSelectedDecrypted('T1');
    expect(sel).toEqual({ id, kind: 'setup_token', secret: 'sk-setup-1' });
  });

  it('getSelectedDecrypted returns null when nothing is selected', async () => {
    const { store, orgs } = makeStore();
    orgs.set('T1', { id: 'T1', selected_claude_credential_id: null } as OrganizationEntity);
    expect(await store.getSelectedDecrypted('T1')).toBeNull();
  });

  it('list() reports summaries with no secret values, flagging the selected row', async () => {
    const { store, orgs } = makeStore();
    orgs.set('T1', { id: 'T1', selected_claude_credential_id: null } as OrganizationEntity);
    const id1 = await store.createSetupToken('T1', { label: 'one', token: 'sk-1' });
    const id2 = await store.createSetupToken('T1', { label: 'two', token: 'sk-2' });
    await store.setSelected('T1', id2);

    const list = await store.list('T1');
    expect(list).toEqual([
      { id: id1, label: 'one', kind: 'setup_token', status: 'active', expiresAt: null, accountEmail: null, isSelected: false },
      { id: id2, label: 'two', kind: 'setup_token', status: 'active', expiresAt: null, accountEmail: null, isSelected: true },
    ]);
  });

  describe('advanceClaudeCredential (atomic monotonic write-back)', () => {
    it('advances a PERSONAL credential to a blob with a NEWER expiresAt', async () => {
      const { store, orgs } = makeStore();
      orgs.set('T1', { id: 'T1', selected_claude_credential_id: null } as OrganizationEntity);
      const id = await store.createPersonal('T1', {
        label: 'p',
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: 1000,
      });
      await store.advanceClaudeCredential('T1', id, oauthBlob(2000, 'new-access', 'new-refresh'));

      const sel = await store.getSelectedDecrypted('T1'); // not selected, so read via list/select instead
      expect(sel).toBeNull();
      await store.setSelected('T1', id);
      const after = await store.getSelectedDecrypted('T1');
      expect(JSON.parse(after!.secret).claudeAiOauth).toMatchObject({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: 2000,
      });
    });

    it('SKIPS a blob with an OLDER or EQUAL expiresAt (never clobbers a newer credential)', async () => {
      const { store, orgs } = makeStore();
      orgs.set('T1', { id: 'T1', selected_claude_credential_id: null } as OrganizationEntity);
      const id = await store.createPersonal('T1', {
        label: 'p',
        accessToken: 'current-access',
        refreshToken: 'current-refresh',
        expiresAt: 2000,
      });
      await store.advanceClaudeCredential('T1', id, oauthBlob(1000, 'stale-access', 'stale-refresh'));
      await store.advanceClaudeCredential('T1', id, oauthBlob(2000, 'sametime-access', 'sametime-refresh'));

      await store.setSelected('T1', id);
      const after = await store.getSelectedDecrypted('T1');
      expect(JSON.parse(after!.secret).claudeAiOauth).toMatchObject({
        accessToken: 'current-access',
        refreshToken: 'current-refresh',
        expiresAt: 2000,
      });
    });

    it('no-ops on a SETUP_TOKEN row (only personal credentials are refreshable)', async () => {
      const { store, orgs } = makeStore();
      orgs.set('T1', { id: 'T1', selected_claude_credential_id: null } as OrganizationEntity);
      const id = await store.createSetupToken('T1', { label: 's', token: 'sk-setup' });
      await store.advanceClaudeCredential('T1', id, oauthBlob(9999));

      await store.setSelected('T1', id);
      const after = await store.getSelectedDecrypted('T1');
      expect(after).toEqual({ id, kind: 'setup_token', secret: 'sk-setup' });
    });

    it('no-ops when the row is missing or credentialId is absent', async () => {
      const { store } = makeStore();
      await expect(store.advanceClaudeCredential('T1', 'ghost', oauthBlob(1000))).resolves.toBeUndefined();
      await expect(store.advanceClaudeCredential('T1', undefined, oauthBlob(1000))).resolves.toBeUndefined();
    });
  });

  describe('upsertLegacySetupToken', () => {
    it('creates ONE canonical row and selects it; repeated calls never duplicate', async () => {
      const { store, orgs } = makeStore();
      orgs.set('T1', { id: 'T1', selected_claude_credential_id: null } as OrganizationEntity);

      await store.upsertLegacySetupToken('T1', 'sk-first');
      const afterFirst = await store.list('T1');
      expect(afterFirst).toHaveLength(1);
      expect(afterFirst[0].isSelected).toBe(true);

      await store.upsertLegacySetupToken('T1', 'sk-second');
      const afterSecond = await store.list('T1');
      expect(afterSecond).toHaveLength(1); // re-encrypted the SAME row, not a duplicate

      const sel = await store.getSelectedDecrypted('T1');
      expect(sel?.secret).toBe('sk-second');
    });
  });

  it('refuses to write without an encryption key', async () => {
    const { store, orgs } = makeStore({ SECRETS_ENCRYPTION_KEY: undefined });
    orgs.set('T1', { id: 'T1', selected_claude_credential_id: null } as OrganizationEntity);
    await expect(store.createSetupToken('T1', { label: 'x', token: 'y' })).rejects.toThrow(
      /SECRETS_ENCRYPTION_KEY is not set/,
    );
  });
});
