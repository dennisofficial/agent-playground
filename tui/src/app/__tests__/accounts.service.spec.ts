import { describe, expect, it, mock } from 'bun:test';
import { EAccountStatus, EEngine } from '../../generated/prisma/enums.js';
import type { Account } from '../../generated/prisma/client.js';
import type { AccountVaultService } from '../../auth/account-vault.service.js';
import type { EngineHomeService } from '../../auth/engine-home.service.js';
import type {
  ClaudeCredentialBlob,
  ClaudeOAuthClient,
} from '../../auth/oauth/claude-oauth.client.js';
import type { AccountRepository } from '../../store/account.repository.js';
import { AccountsService } from '../accounts.service.js';

function build(
  accounts: Partial<Account>[],
  onDisk: ClaudeCredentialBlob | null = null,
) {
  const statuses: { id: string; status: EAccountStatus }[] = [];
  const rows = accounts.map(
    (account) =>
      ({
        engine: EEngine.claude,
        status: EAccountStatus.active,
        fiveHourResetsAt: null,
        ...account,
      }) as unknown as Account,
  );

  const accountRepository = {
    list: mock(async () => rows),
    listForEngine: mock(async () => rows),
    setStatus: mock(async (id: string, status: EAccountStatus) => {
      statuses.push({ id, status });
    }),
  } as unknown as AccountRepository;

  const adopted: { accountId: string; observed: ClaudeCredentialBlob }[] = [];

  return {
    accountsService: new AccountsService(
      accountRepository,
      {
        adopt: mock(async (args: { accountId: string; observed: ClaudeCredentialBlob }) => {
          adopted.push(args);
          return true;
        }),
      } as unknown as AccountVaultService,
      {} as unknown as ClaudeOAuthClient,
      {
        readClaudeCredential: mock(() => onDisk),
      } as unknown as EngineHomeService,
    ),
    statuses,
    adopted,
  };
}

const ON_DISK: ClaudeCredentialBlob = {
  claudeAiOauth: {
    accessToken: 'oat-live',
    refreshToken: 'ort-live',
    expiresAt: 9_999_999,
    scopes: ['user:inference'],
  },
};

const NOW = new Date('2026-01-01T12:00:00Z');

/**
 * A rate limit is a wall with a known end, but nothing was clearing it: `reviveExpiredLimits` existed
 * with no caller at all, so an account limited on Monday was still `limited` on Friday and rotation
 * skipped it forever. Startup is the honest moment to check — the reset may well have passed while
 * Atlas was not running.
 */
describe('AccountsService.onModuleInit', () => {
  it('clears a limit whose reset has already passed', async () => {
    const { accountsService, statuses } = build([
      {
        id: 'spent',
        status: EAccountStatus.limited,
        fiveHourResetsAt: new Date('2026-01-01T11:00:00Z'),
      },
    ]);

    await accountsService.reviveExpiredLimits(NOW);

    expect(statuses).toEqual([{ id: 'spent', status: EAccountStatus.active }]);
  });

  it('leaves a limit that has not lifted yet', async () => {
    const { accountsService, statuses } = build([
      {
        id: 'spent',
        status: EAccountStatus.limited,
        fiveHourResetsAt: new Date('2026-01-01T13:00:00Z'),
      },
    ]);

    await accountsService.reviveExpiredLimits(NOW);

    expect(statuses).toEqual([]);
  });

  /**
   * `expired` is a credential problem, not a quota one — the refresh on the turn path is what decides
   * it. Clearing it here would put an account back in the pool on no evidence at all.
   */
  it('leaves an expired account alone — a clock does not fix a credential', async () => {
    const { accountsService, statuses } = build([
      {
        id: 'dead',
        status: EAccountStatus.expired,
        fiveHourResetsAt: new Date('2026-01-01T11:00:00Z'),
      },
    ]);

    await accountsService.reviveExpiredLimits(NOW);

    expect(statuses).toEqual([]);
  });

  /**
   * The recovery case, and the reason this runs at all. An install whose stored pair went scrap
   * BEFORE this code existed cannot heal on the turn path: the refresh fails, the engine never opens,
   * and so nothing ever writes the file this process would trust. The live pair is nonetheless sitting
   * in the engine home, left there by the CLI's own refresh.
   *
   * One account is what makes it safe: with nobody else on this engine, the file cannot belong to
   * anyone but them. `adopt` still refuses it if it is older than what is stored.
   */
  it('adopts the engine home’s credential at startup when one account owns the engine', async () => {
    const { accountsService, adopted } = build(
      [{ id: 'only', status: EAccountStatus.expired }],
      ON_DISK,
    );

    await accountsService.onModuleInit();

    expect(adopted).toEqual([{ accountId: 'only', observed: ON_DISK }]);
  });

  it('will not guess an owner when two accounts share the engine home', async () => {
    const { accountsService, adopted } = build([{ id: 'a' }, { id: 'b' }], ON_DISK);

    await accountsService.onModuleInit();

    expect(adopted).toEqual([]);
  });

  it('does nothing when the engine home has no credential in it', async () => {
    const { accountsService, adopted } = build([{ id: 'only' }], null);

    await accountsService.onModuleInit();

    expect(adopted).toEqual([]);
  });

  it('runs on startup, so a limit that lifted while Atlas was closed is already gone', async () => {
    const { accountsService, statuses } = build([
      {
        id: 'spent',
        status: EAccountStatus.limited,
        fiveHourResetsAt: new Date('2020-01-01T00:00:00Z'),
      },
    ]);

    await accountsService.onModuleInit();

    expect(statuses).toEqual([{ id: 'spent', status: EAccountStatus.active }]);
  });
});
