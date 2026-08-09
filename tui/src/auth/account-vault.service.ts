import { Injectable, Logger } from "@nestjs/common";
import { EAccountStatus, EEngine } from "../generated/prisma/enums.js";
import type { Account } from "../generated/prisma/client.js";
import { AccountRepository } from "../store/account.repository.js";
import {
  ClaudeOAuthClient,
  ClaudeOAuthHttpError,
  type ClaudeCredentialBlob,
  type ClaudeTokenSet,
} from "./oauth/claude-oauth.client.js";
import { SecretCipherService } from "./secret-cipher.service.js";

const REFRESH_SKEW_MS = 5 * 60 * 1000;

@Injectable()
export class AccountVaultService {
  private readonly logger = new Logger(AccountVaultService.name);

  constructor(
    private readonly accountRepository: AccountRepository,
    private readonly secretCipherService: SecretCipherService,
    private readonly claudeOAuthClient: ClaudeOAuthClient,
  ) {}

  /** Store a freshly-completed Claude login. The label is what the accounts page and chip show. */
  async addClaudeAccount(token: ClaudeTokenSet): Promise<Account> {
    const blob = this.claudeOAuthClient.toBlob(token);
    return this.accountRepository.upsert({
      engine: EEngine.claude,
      label: token.accountEmail ?? "claude account",
      accountEmail: token.accountEmail ?? null,
      subscriptionType: token.subscriptionType ?? null,
      materialEnc: this.secretCipherService.encrypt(JSON.stringify(blob)),
      expiresAt: new Date(token.expiresAt),
    });
  }

  async freshCredential(accountId: string): Promise<ClaudeCredentialBlob> {
    const account = await this.accountRepository.findById(accountId);
    if (!account) throw new Error(`account ${accountId} not found`);

    const blob = this.decode(account);
    const expiresAt = blob.claudeAiOauth.expiresAt;
    if (expiresAt - Date.now() > REFRESH_SKEW_MS) return blob;

    return this.refresh(account, blob);
  }

  private async refresh(
    account: Account,
    blob: ClaudeCredentialBlob,
  ): Promise<ClaudeCredentialBlob> {
    try {
      const token = await this.claudeOAuthClient.refresh(
        blob.claudeAiOauth.refreshToken,
      );
      const next = this.claudeOAuthClient.toBlob(token);
      await this.accountRepository.updateMaterial(
        account.id,
        this.secretCipherService.encrypt(JSON.stringify(next)),
        new Date(token.expiresAt),
      );
      this.logger.log(`refreshed credential for ${account.label}`);
      return next;
    } catch (error) {
      // A hard auth failure means the account is dead and rotation should skip it; a network blip
      // means try the existing token, which may still have a few minutes on it.
      if (
        error instanceof ClaudeOAuthHttpError &&
        this.claudeOAuthClient.isHardAuthFailure(error.status)
      ) {
        await this.accountRepository.setStatus(
          account.id,
          EAccountStatus.expired,
        );
        throw error;
      }
      this.logger.warn(
        `refresh failed for ${account.label}, using existing token`,
      );
      return blob;
    }
  }

  private decode(account: Account): ClaudeCredentialBlob {
    return JSON.parse(
      this.secretCipherService.decrypt(account.materialEnc),
    ) as ClaudeCredentialBlob;
  }
}
