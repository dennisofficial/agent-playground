import { Injectable, Logger } from "@nestjs/common";
import { AccountVaultService } from "../auth/account-vault.service.js";
import { ClaudeUsageClient } from "../auth/oauth/claude-usage.client.js";
import { AccountRepository } from "../store/account.repository.js";
import { ConversationStoreRegistry } from "./conversation-store.registry.js";

const POLL_FLOOR_MS = 20_000;
const LIVE_POLL_MS = 60_000;

@Injectable()
export class AccountUsageService {
  private readonly logger = new Logger(AccountUsageService.name);
  private readonly polledAt = new Map<string, number>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly accountVaultService: AccountVaultService,
    private readonly claudeUsageClient: ClaudeUsageClient,
    private readonly accountRepository: AccountRepository,
    private readonly stores: ConversationStoreRegistry,
  ) {}

  /**
   * Named arguments throughout: the pair is two opaque ids of the same type, and transposing them
   * polls the wrong account and writes the reading into a different thread's meters — a wrong number
   * on screen rather than a crash, which is the kind of bug that survives a release.
   */
  kick(args: { accountId: string; threadId: string; force?: boolean }): void {
    void this.refresh({ ...args, force: args.force ?? false });
  }

  track(args: { accountId: string; threadId: string }): void {
    this.untrack(args.threadId);
    this.kick(args);
    const timer = setInterval(() => this.kick(args), LIVE_POLL_MS);
    timer.unref();
    this.timers.set(args.threadId, timer);
  }

  stopTracking(args: { accountId: string; threadId: string }): void {
    this.untrack(args.threadId);
    this.kick({ ...args, force: true });
  }

  private untrack(threadId: string): void {
    const timer = this.timers.get(threadId);
    if (!timer) return;
    clearInterval(timer);
    this.timers.delete(threadId);
  }

  private async refresh(args: {
    accountId: string;
    threadId: string;
    force: boolean;
  }): Promise<void> {
    const { accountId, threadId, force } = args;
    const last = this.polledAt.get(accountId);
    if (!force && last !== undefined && Date.now() - last < POLL_FLOOR_MS)
      return;
    // Stamped before the request so an in-flight poll holds the floor too.
    this.polledAt.set(accountId, Date.now());

    try {
      const credential =
        await this.accountVaultService.freshCredential(accountId);
      const windows = await this.claudeUsageClient.fetch(
        credential.claudeAiOauth.accessToken,
      );
      if (!windows) return;

      const store = this.stores.for(threadId);
      store.setUsage("fiveHour", windows.fiveHour);
      store.setUsage("sevenDay", windows.sevenDay);

      if (windows.fiveHour) {
        await this.accountRepository.recordUsage(accountId, {
          window: "fiveHour",
          utilization: windows.fiveHour.utilization,
          resetsAt: windows.fiveHour.resetsAt ?? undefined,
        });
      }
      if (windows.sevenDay) {
        await this.accountRepository.recordUsage(accountId, {
          window: "sevenDay",
          utilization: windows.sevenDay.utilization,
          resetsAt: windows.sevenDay.resetsAt ?? undefined,
        });
      }
    } catch (error) {
      this.logger.warn(
        `usage refresh failed for account ${accountId}: ${String(error)}`,
      );
    }
  }
}
