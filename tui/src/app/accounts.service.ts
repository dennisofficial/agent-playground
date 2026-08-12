import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { AccountVaultService } from "../auth/account-vault.service.js";
import { EngineHomeService } from "../auth/engine-home.service.js";
import {
  ClaudeOAuthClient,
  type Pkce,
} from "../auth/oauth/claude-oauth.client.js";
import { EAccountStatus, EEngine } from "../generated/prisma/enums.js";
import type { Account } from "../generated/prisma/client.js";
import { AccountRepository } from "../store/account.repository.js";

export type AccountRow = Account & { isActive: boolean };

export type ClaudeLogin = { url: string; pkce: Pkce };

@Injectable()
export class AccountsService implements OnModuleInit {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    private readonly accountRepository: AccountRepository,
    private readonly accountVaultService: AccountVaultService,
    private readonly claudeOAuthClient: ClaudeOAuthClient,
    private readonly engineHomeService: EngineHomeService,
  ) {}

  /**
   * A rate limit is the one wall that lifts on its own, and Atlas is usually not running when it
   * does. Nothing used to clear it: `reviveExpiredLimits` had no caller anywhere, so an account
   * limited yesterday was still `limited` today and rotation kept skipping it. Startup is the honest
   * moment to look — the reset has very likely passed since the last run.
   *
   * A local read and at most one write per stale row: no network, nothing that can delay the first
   * frame. Swallowed on failure because several Atlas instances start at once as a matter of course,
   * and a contended write must not stop the app opening over a status it can fix at the next start.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.reviveExpiredLimits();
      await this.adoptEngineHomeCredential(EEngine.claude);
    } catch (error: unknown) {
      this.logger.warn(`could not tidy accounts at startup: ${String(error)}`);
    }
  }

  /**
   * Recover a credential Atlas lost track of before it knew to look.
   *
   * The engine refreshes the credentials file in its home and rotates the refresh token as it does, so
   * an install from before that was read back holds a pair the server has already invalidated — and it
   * cannot heal on the turn path, because the refresh fails, the engine never opens, and nothing ever
   * writes the file a turn would trust. Meanwhile the working pair is sitting right there in the home.
   *
   * ONE account for the engine is what makes this safe. The home is shared by every account of an
   * engine, so with two of them the file's owner is a guess — and guessing wrong files one
   * subscription's credential under another's email. `adopt` still refuses a pair older than the
   * stored one, so this can only ever move a credential forward.
   */
  private async adoptEngineHomeCredential(engine: EEngine): Promise<void> {
    const accounts = await this.accountRepository.listForEngine(engine);
    const [only] = accounts;
    if (!only || accounts.length > 1) return;

    const observed = this.engineHomeService.readClaudeCredential();
    if (!observed) return;

    await this.accountVaultService.adopt({ accountId: only.id, observed });
  }

  async list(activeAccountId?: string): Promise<AccountRow[]> {
    const accounts = await this.accountRepository.list();
    return accounts.map((account) => ({
      ...account,
      isActive: account.id === activeAccountId,
    }));
  }

  async count(): Promise<number> {
    return this.accountRepository.count();
  }

  beginClaudeLogin(): ClaudeLogin {
    const pkce = this.claudeOAuthClient.generatePkce();
    return { url: this.claudeOAuthClient.buildAuthorizeUrl(pkce), pkce };
  }

  async completeClaudeLogin(
    login: ClaudeLogin,
    pastedCode: string,
  ): Promise<Account> {
    const token = await this.claudeOAuthClient.exchangeCode({
      code: pastedCode,
      verifier: login.pkce.verifier,
      state: login.pkce.state,
    });
    return this.accountVaultService.addClaudeAccount(token);
  }

  async remove(id: string): Promise<void> {
    await this.accountRepository.remove(id);
  }

  async listForEngine(engine: EEngine): Promise<Account[]> {
    return this.accountRepository.listForEngine(engine);
  }

  async reviveExpiredLimits(now = new Date()): Promise<void> {
    const accounts = await this.accountRepository.list();
    for (const account of accounts) {
      const cleared =
        account.status === EAccountStatus.limited &&
        account.fiveHourResetsAt !== null &&
        account.fiveHourResetsAt <= now;
      if (cleared)
        await this.accountRepository.setStatus(
          account.id,
          EAccountStatus.active,
        );
    }
  }
}
