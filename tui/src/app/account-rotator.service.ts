import { Injectable, Logger } from "@nestjs/common";
import { EAccountStatus, type EEngine } from "../generated/prisma/enums.js";
import type { Account } from "../generated/prisma/client.js";
import { chooseNext, isWalled } from "../domain/rotation.js";
import { AccountRepository } from "../store/account.repository.js";
import { SessionRepository } from "../store/session.repository.js";

export { ROTATE_ABOVE } from "../domain/rotation.js";

export type RotationOutcome =
  | { kind: "kept" }
  | { kind: "rotated"; from: Account; to: Account }
  | { kind: "parked"; resumesAt: Date | null; accounts: Account[] };

/**
 * IO around `domain/rotation.ts` — read the accounts, apply the decision, write the session. The
 * decision itself is pure and lives there so it can be tested without a database.
 */
@Injectable()
export class AccountRotatorService {
  private readonly logger = new Logger(AccountRotatorService.name);

  constructor(
    private readonly accountRepository: AccountRepository,
    private readonly sessionRepository: SessionRepository,
  ) {}

  async considerRotation(args: {
    sessionId: string;
    accountId: string;
    engine: EEngine;
  }): Promise<RotationOutcome> {
    const current = await this.accountRepository.findById(args.accountId);
    if (!current) return { kind: "kept" };
    if (!isWalled(current)) return { kind: "kept" };

    return this.rotate({ sessionId: args.sessionId, current, engine: args.engine });
  }

  /**
   * The API refused the turn outright. Record the wall first — including the reset it reported,
   * which is better information than any poll — then rotate on the same rules as a predicted wall.
   */
  async rotateAfterLimit(args: {
    sessionId: string;
    accountId: string;
    engine: EEngine;
    resetsAt: Date | null;
  }): Promise<RotationOutcome> {
    await this.accountRepository.setStatus(args.accountId, EAccountStatus.limited);
    if (args.resetsAt) {
      await this.accountRepository.recordUsage(args.accountId, {
        window: "fiveHour",
        utilization: 100,
        resetsAt: args.resetsAt.toISOString(),
      });
    }
    const current = await this.accountRepository.findById(args.accountId);
    if (!current) return { kind: "kept" };
    return this.rotate({ sessionId: args.sessionId, current, engine: args.engine });
  }

  private async rotate(args: {
    sessionId: string;
    current: Account;
    engine: EEngine;
  }): Promise<RotationOutcome> {
    // One read, reused for both the choice and the parked report — they must describe the same
    // moment, or the countdown can name a reset that the choice never saw.
    const accounts = await this.accountRepository.listForEngine(args.engine);
    const choice = chooseNext({ currentId: args.current.id, accounts });

    if (choice.kind === "parked") {
      return { kind: "parked", resumesAt: choice.resumesAt, accounts };
    }

    await this.sessionRepository.setAccount({
      sessionId: args.sessionId,
      accountId: choice.to.id,
    });
    this.logger.log(`rotated ${args.current.label} → ${choice.to.label}`);
    return { kind: "rotated", from: args.current, to: choice.to };
  }
}
