import { Injectable } from "@nestjs/common";
import { AccountVaultService } from "../auth/account-vault.service.js";
import {
  ClaudeOAuthClient,
  type Pkce,
} from "../auth/oauth/claude-oauth.client.js";
import { EAccountStatus, type EEngine } from "../generated/prisma/enums.js";
import type { Account } from "../generated/prisma/client.js";
import { AccountRepository } from "../store/account.repository.js";

export type AccountRow = Account & { isActive: boolean };

export type ClaudeLogin = { url: string; pkce: Pkce };

@Injectable()
export class AccountsService {
  constructor(
    private readonly accountRepository: AccountRepository,
    private readonly accountVaultService: AccountVaultService,
    private readonly claudeOAuthClient: ClaudeOAuthClient,
  ) {}

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
