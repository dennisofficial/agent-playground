import { Injectable } from "@nestjs/common";
import { EAccountStatus, type EEngine } from "../generated/prisma/enums.js";
import type { Account } from "../generated/prisma/client.js";
import type { UsageWindowKey } from "../domain/message.js";
import { PrismaService } from "./prisma.service.js";

export type UsageUpdate = {
  window: UsageWindowKey;
  utilization: number;
  resetsAt?: string | undefined;
};

@Injectable()
export class AccountRepository {
  constructor(private readonly prismaService: PrismaService) {}

  async list(): Promise<Account[]> {
    return this.prismaService.account.findMany({
      orderBy: [{ engine: "asc" }, { createdAt: "asc" }],
    });
  }

  async listForEngine(engine: EEngine): Promise<Account[]> {
    return this.prismaService.account.findMany({
      where: { engine },
      orderBy: { createdAt: "asc" },
    });
  }

  async findById(id: string): Promise<Account | null> {
    return this.prismaService.account.findUnique({ where: { id } });
  }

  async count(): Promise<number> {
    return this.prismaService.account.count();
  }

  async upsert(args: {
    engine: EEngine;
    label: string;
    accountEmail: string | null;
    subscriptionType: string | null;
    materialEnc: string;
    expiresAt: Date | null;
  }): Promise<Account> {
    const { engine, accountEmail, ...rest } = args;
    const data = {
      ...rest,
      status: EAccountStatus.active,
      lastRefreshedAt: new Date(),
    };
    // `@@unique([engine, accountEmail])` — re-logging the same account updates it in place rather
    // than accumulating duplicate rows.
    const existing = await this.prismaService.account.findFirst({
      where: { engine, accountEmail },
    });
    if (existing) {
      return this.prismaService.account.update({
        where: { id: existing.id },
        data,
      });
    }
    return this.prismaService.account.create({
      data: { engine, accountEmail, ...data },
    });
  }

  async updateMaterial(
    id: string,
    materialEnc: string,
    expiresAt: Date | null,
  ): Promise<void> {
    await this.prismaService.account.update({
      where: { id },
      data: { materialEnc, expiresAt, lastRefreshedAt: new Date() },
    });
  }

  async setStatus(id: string, status: EAccountStatus): Promise<void> {
    await this.prismaService.account.update({
      where: { id },
      data: { status },
    });
  }

  async recordUsage(id: string, update: UsageUpdate): Promise<void> {
    const resetsAt = update.resetsAt ? new Date(update.resetsAt) : null;
    const data =
      update.window === "fiveHour"
        ? { fiveHourUtil: update.utilization, fiveHourResetsAt: resetsAt }
        : { sevenDayUtil: update.utilization, sevenDayResetsAt: resetsAt };
    await this.prismaService.account.update({
      where: { id },
      data: { ...data, usageFetchedAt: new Date() },
    });
  }

  /**
   * What the SERVER says about this account's credits. Separate from `setPolicy` on purpose: one is
   * observed and overwritten by every poll, the other is a human's standing decision, and a poll
   * that touched the decision would silently un-say it.
   */
  async recordExtraUsage(
    id: string,
    /**
     * Both optional, because the two sources know different halves. The usage poll reports
     * provisioning AND balance; a mid-turn frame only ever reports a refusal. An omitted field is
     * left as it was rather than nulled — a partial reading must not erase a complete one.
     */
    update: { enabled?: boolean; utilization?: number | null },
  ): Promise<void> {
    await this.prismaService.account.update({
      where: { id },
      data: {
        ...(update.enabled === undefined ? {} : { extraUsageEnabled: update.enabled }),
        ...(update.utilization === undefined ? {} : { extraUsageUtil: update.utilization }),
        usageFetchedAt: new Date(),
      },
    });
  }

  /** The two standing decisions a human makes about an account. Independent by design — see the schema. */
  async setPolicy(
    id: string,
    policy: { extraUsageAllowed?: boolean; fastMode?: boolean },
  ): Promise<void> {
    await this.prismaService.account.update({ where: { id }, data: policy });
  }

  /**
   * Forgetting a credential, which is an auth operation and nothing more.
   *
   * There is deliberately no guard here any more. `EngineSession.accountId` was `RESTRICT`, so an
   * account became undeletable the moment it ran one turn, and this method translated the raw
   * foreign-key error into advice to re-add the account instead — a workaround for a constraint that
   * was defending nothing: rotation overwrites that column at every turn boundary, so it never held
   * "who paid for this session", and no reader treats it as history.
   *
   * It is `SetNull` now. The sessions, their transcripts and their ledger rows all survive with the
   * pointer cleared, and the next turn resolves an account onto them again.
   */
  async remove(id: string): Promise<void> {
    await this.prismaService.account.delete({ where: { id } });
  }
}
