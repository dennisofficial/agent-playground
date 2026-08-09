import { Injectable, Logger } from "@nestjs/common";
import { EAccountStatus, type EEngine } from "../generated/prisma/enums.js";
import type { Account } from "../generated/prisma/client.js";
import { AccountRepository } from "../store/account.repository.js";
import { SessionRepository } from "../store/session.repository.js";

export const ROTATE_ABOVE = 95;

export type RotationOutcome =
  | { kind: "kept" }
  | { kind: "rotated"; from: Account; to: Account }
  | { kind: "parked"; resumesAt: Date | null; accounts: Account[] };

@Injectable()
export class AccountRotatorService {
  private readonly logger = new Logger(AccountRotatorService.name);

  constructor(
    private readonly accountRepository: AccountRepository,
    private readonly sessionRepository: SessionRepository,
  ) {}

  async considerRotation(
    sessionId: string,
    accountId: string,
    engine: EEngine,
  ): Promise<RotationOutcome> {
    const current = await this.accountRepository.findById(accountId);
    if (!current) return { kind: "kept" };

    const walled =
      current.status === EAccountStatus.limited || overThreshold(current);
    if (!walled) return { kind: "kept" };

    return this.rotate(sessionId, current, engine);
  }

  async rotateAfterLimit(
    sessionId: string,
    accountId: string,
    engine: EEngine,
    resetsAt: Date | null,
  ): Promise<RotationOutcome> {
    await this.accountRepository.setStatus(accountId, EAccountStatus.limited);
    if (resetsAt) {
      await this.accountRepository.recordUsage(accountId, {
        window: "fiveHour",
        utilization: 100,
        resetsAt: resetsAt.toISOString(),
      });
    }
    const current = await this.accountRepository.findById(accountId);
    if (!current) return { kind: "kept" };
    return this.rotate(sessionId, current, engine);
  }

  private async rotate(
    sessionId: string,
    current: Account,
    engine: EEngine,
  ): Promise<RotationOutcome> {
    const candidates = (
      await this.accountRepository.listForEngine(engine)
    ).filter(
      (a) =>
        a.id !== current.id &&
        a.status === EAccountStatus.active &&
        !overThreshold(a),
    );

    if (candidates.length === 0) {
      const all = await this.accountRepository.listForEngine(engine);
      return { kind: "parked", resumesAt: earliestReset(all), accounts: all };
    }

    const [next] = [...candidates].sort(
      (a, b) => (a.fiveHourUtil ?? 101) - (b.fiveHourUtil ?? 101),
    );
    const target = next as Account;

    await this.sessionRepository.setAccount(sessionId, target.id);
    this.logger.log(`rotated ${current.label} → ${target.label}`);
    return { kind: "rotated", from: current, to: target };
  }
}

function overThreshold(account: Account): boolean {
  return (
    (account.fiveHourUtil ?? 0) >= ROTATE_ABOVE ||
    (account.sevenDayUtil ?? 0) >= 100
  );
}

function earliestReset(accounts: Account[]): Date | null {
  const resets = accounts
    .map((a) => a.fiveHourResetsAt)
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => a.getTime() - b.getTime());
  return resets[0] ?? null;
}
