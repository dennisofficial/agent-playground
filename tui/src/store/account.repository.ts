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

  async remove(id: string): Promise<void> {
    await this.prismaService.account.delete({ where: { id } });
  }
}
