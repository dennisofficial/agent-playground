import { Injectable } from '@nestjs/common';
import type { EEngine, ESessionEndReason } from '../generated/prisma/enums.js';
import type { EngineSession } from '../generated/prisma/client.js';
import type { SessionRef } from '../domain/seam.js';
import { PrismaService } from './prisma.service.js';

/** A soft lock goes stale rather than leaking — a crashed instance must not wedge a thread. */
export const LOCK_STALE_MS = 60_000;

@Injectable()
export class SessionRepository {
  constructor(private readonly prismaService: PrismaService) {}

  async findById(id: string): Promise<EngineSession | null> {
    return this.prismaService.engineSession.findUnique({ where: { id } });
  }

  /** Just enough for `withSeams` — the transcript never needs the whole row. */
  async refsForThread(threadId: string): Promise<SessionRef[]> {
    const sessions = await this.prismaService.engineSession.findMany({
      where: { threadId },
      orderBy: { ordinal: 'asc' },
      select: { id: true, ordinal: true, endReason: true },
    });
    return sessions;
  }

  /**
   * Opens the next session under a thread. `ordinal` is "leg 2" in the breadcrumb; `engine` and
   * `model` are frozen here from the thread's role so history stays truthful when the role→engine
   * table later changes.
   */
  async open(args: {
    threadId: string;
    accountId: string;
    engine: EEngine;
    model: string;
    seededFromId?: string;
    handoff?: string;
  }): Promise<EngineSession> {
    const last = await this.prismaService.engineSession.findFirst({
      where: { threadId: args.threadId },
      orderBy: { ordinal: 'desc' },
    });
    return this.prismaService.engineSession.create({
      data: {
        threadId: args.threadId,
        accountId: args.accountId,
        engine: args.engine,
        model: args.model,
        ordinal: (last?.ordinal ?? 0) + 1,
        ...(args.seededFromId === undefined ? {} : { seededFromId: args.seededFromId }),
        ...(args.handoff === undefined ? {} : { handoff: args.handoff }),
      },
    });
  }

  /** The SDK's own id, learned from the first frame of the first turn. Needed to resume. */
  async recordEngineSessionId(id: string, engineSessionId: string): Promise<void> {
    await this.prismaService.engineSession.update({
      where: { id },
      data: { engineSessionId },
    });
  }

  /**
   * Written once per turn, not once per frame. It exists so reopening a thread shows its real
   * context pressure instead of `—` until the next turn produces a reading.
   */
  async recordContextPercent(id: string, contextPercent: number): Promise<void> {
    await this.prismaService.engineSession.update({ where: { id }, data: { contextPercent } });
  }

  /**
   * Rotation updates the account IN PLACE — a session can outlive several accounts, and nothing
   * else about it changes. The transcript, the resume id and the scroll all survive, because the
   * API is stateless and auth is a per-turn concern.
   */
  async setAccount(id: string, accountId: string): Promise<void> {
    await this.prismaService.engineSession.update({ where: { id }, data: { accountId } });
  }

  async end(id: string, endReason: ESessionEndReason): Promise<void> {
    await this.prismaService.engineSession.update({
      where: { id },
      data: { endReason, endedAt: new Date(), lockedBy: null },
    });
  }

  /**
   * Claim a session for this process. Two instances could otherwise run a turn into one
   * conversation; the loser opens read-only and says so.
   */
  async claim(id: string, now = Date.now()): Promise<boolean> {
    const session = await this.prismaService.engineSession.findUnique({
      where: { id },
      select: { lockedBy: true },
    });
    if (!session) return false;

    const held = parseLock(session.lockedBy);
    const mine = held?.pid === process.pid;
    const stale = held !== null && now - held.at > LOCK_STALE_MS;
    if (held !== null && !mine && !stale) return false;

    await this.prismaService.engineSession.update({
      where: { id },
      data: { lockedBy: `${process.pid}:${now}` },
    });
    return true;
  }

  async release(id: string): Promise<void> {
    await this.prismaService.engineSession.update({ where: { id }, data: { lockedBy: null } });
  }
}

export function parseLock(lockedBy: string | null): { pid: number; at: number } | null {
  if (!lockedBy) return null;
  const [pid, at] = lockedBy.split(':');
  const parsedPid = Number(pid);
  const parsedAt = Number(at);
  if (!Number.isFinite(parsedPid) || !Number.isFinite(parsedAt)) return null;
  return { pid: parsedPid, at: parsedAt };
}
