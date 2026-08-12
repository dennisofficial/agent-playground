import { Injectable, Logger } from "@nestjs/common";
import { EAccountStatus, EEngine } from "../generated/prisma/enums.js";
import type { Account } from "../generated/prisma/client.js";
import {
  decideAdoption,
  type TokenPair,
} from "../domain/credential-rotation.js";
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

  /**
   * Take up the credential the ENGINE refreshed, in the home Atlas handed it.
   *
   * The engine refreshes its credentials file in place when the access token nears expiry, and the
   * server rotates the refresh token as it does. Nothing used to read that file back, so from the
   * first engine-side refresh onwards the pair in the database was scrap — and the next refresh Atlas
   * tried failed with a 4xx that marked a perfectly live account dead. Adopting closes that loop:
   * whoever refreshed last, Atlas ends up holding the pair that works.
   *
   * Returns whether anything was written, which is the only thing the caller can usefully log.
   */
  async adopt(args: {
    accountId: string;
    observed: ClaudeCredentialBlob;
  }): Promise<boolean> {
    const account = await this.accountRepository.findById(args.accountId);
    if (!account) return false;

    const decision = decideAdoption({
      observed: pairOf(args.observed),
      stored: pairOf(this.decode(account)),
      others: await this.otherPairs(account),
    });
    if (decision !== "adopt") {
      // `foreign` is the one worth saying out loud: it means two Atlas instances are running turns on
      // different accounts through one engine home, and one of them has just lost a refresh.
      if (decision === "foreign")
        this.logger.warn(
          `engine home holds another account's credential — not adopting it for ${account.label}`,
        );
      return false;
    }

    await this.persist({ account, blob: args.observed });
    this.logger.log(`adopted the engine's refreshed credential for ${account.label}`);
    return true;
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
      await this.persist({ account, blob: next });
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

  /**
   * Store material, and clear a stale `expired` while doing it. A credential that just worked is
   * proof the status is out of date — and `expired` is otherwise a one-way door, because nothing else
   * ever writes `active` back. That door is what turned one bad refresh into a week of "no usable
   * claude account".
   */
  private async persist(args: {
    account: Account;
    blob: ClaudeCredentialBlob;
  }): Promise<void> {
    await this.accountRepository.updateMaterial(
      args.account.id,
      this.secretCipherService.encrypt(JSON.stringify(args.blob)),
      new Date(args.blob.claudeAiOauth.expiresAt),
    );
    if (args.account.status !== EAccountStatus.active) {
      await this.accountRepository.setStatus(
        args.account.id,
        EAccountStatus.active,
      );
    }
  }

  /** Every OTHER account of the same engine, as token pairs — the owners a shared home can confuse. */
  private async otherPairs(account: Account): Promise<TokenPair[]> {
    const siblings = await this.accountRepository.listForEngine(account.engine);
    return siblings
      .filter((sibling) => sibling.id !== account.id)
      .flatMap((sibling) => {
        try {
          return [pairOf(this.decode(sibling))];
        } catch {
          // A row we cannot decrypt cannot be confused with anything either.
          return [];
        }
      });
  }

  private decode(account: Account): ClaudeCredentialBlob {
    return JSON.parse(
      this.secretCipherService.decrypt(account.materialEnc),
    ) as ClaudeCredentialBlob;
  }
}

function pairOf(blob: ClaudeCredentialBlob): TokenPair {
  return {
    accessToken: blob.claudeAiOauth.accessToken,
    refreshToken: blob.claudeAiOauth.refreshToken,
    expiresAt: blob.claudeAiOauth.expiresAt,
  };
}
