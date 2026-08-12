import { describe, expect, it, mock } from 'bun:test';
import { EAccountStatus, EEngine } from '../../generated/prisma/enums.js';
import type { Account } from '../../generated/prisma/client.js';
import type { AccountRepository } from '../../store/account.repository.js';
import { AccountVaultService } from '../account-vault.service.js';
import {
  ClaudeOAuthClient,
  ClaudeOAuthHttpError,
  type ClaudeCredentialBlob,
  type ClaudeTokenSet,
} from '../oauth/claude-oauth.client.js';
import { SecretCipherService } from '../secret-cipher.service.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOUR = 60 * 60 * 1000;

function blob(over: Partial<ClaudeCredentialBlob['claudeAiOauth']> = {}): ClaudeCredentialBlob {
  return {
    claudeAiOauth: {
      accessToken: 'oat-1',
      refreshToken: 'ort-1',
      expiresAt: Date.now() + 8 * HOUR,
      scopes: ['user:inference'],
      ...over,
    },
  };
}

/**
 * A real cipher over a temp key, because the material round-trip IS the thing under test — a fake
 * that stored plaintext would pass while the real one wrote a blob nothing could read back.
 */
function build(args: {
  accounts: (Partial<Account> & { id: string; blob: ClaudeCredentialBlob })[];
  refresh?: () => Promise<ClaudeTokenSet>;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-vault-'));
  const cipher = new SecretCipherService(join(dir, 'key'));

  const rows = new Map<string, Account>(
    args.accounts.map((account) => [
      account.id,
      {
        engine: EEngine.claude,
        label: account.id,
        status: EAccountStatus.active,
        materialEnc: cipher.encrypt(JSON.stringify(account.blob)),
        ...account,
      } as unknown as Account,
    ]),
  );

  const updates: { id: string; blob: ClaudeCredentialBlob; expiresAt: Date | null }[] = [];
  const statuses: { id: string; status: EAccountStatus }[] = [];

  const accountRepository = {
    findById: mock(async (id: string) => rows.get(id) ?? null),
    listForEngine: mock(async (engine: EEngine) =>
      [...rows.values()].filter((row) => row.engine === engine),
    ),
    updateMaterial: mock(async (id: string, materialEnc: string, expiresAt: Date | null) => {
      updates.push({
        id,
        blob: JSON.parse(cipher.decrypt(materialEnc)) as ClaudeCredentialBlob,
        expiresAt,
      });
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, materialEnc });
    }),
    setStatus: mock(async (id: string, status: EAccountStatus) => {
      statuses.push({ id, status });
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, status });
    }),
  } as unknown as AccountRepository;

  const oauth = new ClaudeOAuthClient();
  const refresh = mock(args.refresh ?? (async () => ({}) as ClaudeTokenSet));
  oauth.refresh = refresh as unknown as typeof oauth.refresh;

  return {
    vault: new AccountVaultService(accountRepository, cipher, oauth),
    updates,
    statuses,
    refresh,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const REFRESHED: ClaudeTokenSet = {
  accessToken: 'oat-2',
  refreshToken: 'ort-2',
  expiresAt: Date.now() + 8 * HOUR,
  scopes: 'user:inference user:profile',
};

describe('AccountVaultService.freshCredential', () => {
  it('hands back the stored credential while it still has time on it', async () => {
    // One `blob()` shared by the row and the assertion: two calls differ by a millisecond of clock.
    const stored = blob();
    const { vault, refresh, cleanup } = build({ accounts: [{ id: 'a', blob: stored }] });

    expect(await vault.freshCredential('a')).toEqual(stored);
    expect(refresh).not.toHaveBeenCalled();
    cleanup();
  });

  it('refreshes and persists a credential inside the skew window', async () => {
    const { vault, updates, cleanup } = build({
      accounts: [{ id: 'a', blob: blob({ expiresAt: Date.now() + 60_000 }) }],
      refresh: async () => REFRESHED,
    });

    const fresh = await vault.freshCredential('a');

    expect(fresh.claudeAiOauth.accessToken).toBe('oat-2');
    expect(updates[0]?.blob.claudeAiOauth.refreshToken).toBe('ort-2');
    cleanup();
  });

  /**
   * The healing half. `expired` is the memory of one failed refresh, and a refresh that WORKS is
   * proof that memory is stale — without this the account stays unusable until the human notices the
   * badge and logs in again.
   */
  it('reactivates an expired account whose refresh succeeds', async () => {
    const { vault, statuses, cleanup } = build({
      accounts: [
        {
          id: 'a',
          status: EAccountStatus.expired,
          blob: blob({ expiresAt: Date.now() - HOUR }),
        },
      ],
      refresh: async () => REFRESHED,
    });

    await vault.freshCredential('a');

    expect(statuses).toEqual([{ id: 'a', status: EAccountStatus.active }]);
    cleanup();
  });

  it('leaves an already-active account’s status alone', async () => {
    const { vault, statuses, cleanup } = build({
      accounts: [{ id: 'a', blob: blob({ expiresAt: Date.now() + 60_000 }) }],
      refresh: async () => REFRESHED,
    });

    await vault.freshCredential('a');

    expect(statuses).toEqual([]);
    cleanup();
  });

  it('marks the account expired and rethrows on a hard auth failure', async () => {
    const { vault, statuses, cleanup } = build({
      accounts: [{ id: 'a', blob: blob({ expiresAt: Date.now() - HOUR }) }],
      refresh: async () => {
        throw new ClaudeOAuthHttpError(401);
      },
    });

    await expect(vault.freshCredential('a')).rejects.toThrow('HTTP 401');
    expect(statuses).toEqual([{ id: 'a', status: EAccountStatus.expired }]);
    cleanup();
  });

  it('falls back to the existing token on a network blip — it may still have minutes on it', async () => {
    const { vault, statuses, cleanup } = build({
      accounts: [{ id: 'a', blob: blob({ expiresAt: Date.now() + 60_000 }) }],
      refresh: async () => {
        throw new Error('fetch failed');
      },
    });

    expect((await vault.freshCredential('a')).claudeAiOauth.accessToken).toBe('oat-1');
    expect(statuses).toEqual([]);
    cleanup();
  });
});

/**
 * Adopting what the ENGINE refreshed. This is the path that stops the whole failure: the CLI
 * refreshes the credentials file Atlas gave it, the server rotates the refresh token, and until this
 * existed the pair in the database was scrap from that moment on.
 */
describe('AccountVaultService.adopt', () => {
  it('persists a pair the engine rotated under us', async () => {
    const { vault, updates, cleanup } = build({ accounts: [{ id: 'a', blob: blob() }] });
    // Later expiry than the stored pair, because that is what a refresh produces — an EARLIER one is
    // refused as stale, and has its own case in `domain/__tests__/credential-rotation.spec.ts`.
    const expiresAt = Date.now() + 16 * HOUR;
    const observed = blob({ accessToken: 'oat-9', refreshToken: 'ort-9', expiresAt });

    expect(await vault.adopt({ accountId: 'a', observed })).toBe(true);
    expect(updates).toEqual([{ id: 'a', blob: observed, expiresAt: new Date(expiresAt) }]);
    cleanup();
  });

  it('refuses a pair older than the one it holds, rather than undoing its own refresh', async () => {
    const { vault, updates, cleanup } = build({ accounts: [{ id: 'a', blob: blob() }] });
    const observed = blob({
      accessToken: 'oat-old',
      refreshToken: 'ort-old',
      expiresAt: Date.now() - HOUR,
    });

    expect(await vault.adopt({ accountId: 'a', observed })).toBe(false);
    expect(updates).toEqual([]);
    cleanup();
  });

  it('reactivates an account whose live credential the engine handed back', async () => {
    const { vault, statuses, cleanup } = build({
      accounts: [{ id: 'a', status: EAccountStatus.expired, blob: blob() }],
    });

    await vault.adopt({ accountId: 'a', observed: blob({ accessToken: 'oat-9' }) });

    expect(statuses).toEqual([{ id: 'a', status: EAccountStatus.active }]);
    cleanup();
  });

  it('writes nothing when the file still holds the pair we wrote', async () => {
    const { vault, updates, cleanup } = build({ accounts: [{ id: 'a', blob: blob() }] });

    expect(await vault.adopt({ accountId: 'a', observed: blob() })).toBe(false);
    expect(updates).toEqual([]);
    cleanup();
  });

  /**
   * Two Atlas instances share one engine home, so the file can hold another account's credential by
   * the time this runs. Recognising it is what stops account B's refresh token being filed under A.
   */
  it('refuses a pair it can recognise as another account’s', async () => {
    const { vault, updates, cleanup } = build({
      accounts: [
        { id: 'a', blob: blob() },
        { id: 'b', blob: blob({ accessToken: 'oat-b', refreshToken: 'ort-b' }) },
      ],
    });

    const observed = blob({ accessToken: 'oat-b', refreshToken: 'ort-b' });

    expect(await vault.adopt({ accountId: 'a', observed })).toBe(false);
    expect(updates).toEqual([]);
    cleanup();
  });

  it('ignores an account that has since been removed', async () => {
    const { vault, updates, cleanup } = build({ accounts: [] });

    expect(await vault.adopt({ accountId: 'gone', observed: blob() })).toBe(false);
    expect(updates).toEqual([]);
    cleanup();
  });
});
