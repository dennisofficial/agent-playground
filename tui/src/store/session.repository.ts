import { Injectable } from '@nestjs/common';
import type { ESessionEndReason } from '../generated/prisma/enums.js';
import type { EngineSession } from '../generated/prisma/client.js';
import type { EngineConfig } from '../domain/role-engine.js';
import type { SessionRef } from '../domain/seam.js';
import { PrismaService } from './prisma.service.js';

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
   * Opens the next session under a thread. `ordinal` is "leg 2" in the breadcrumb; the whole
   * resolved `engineConfig` is frozen here from the thread's role so history stays truthful when
   * the role→engine table later changes — effort included, which is why it is copied at open rather
   * than looked up per turn.
   *
   * `engine` and `model` are ALSO written flat, duplicating what the JSON already holds. That is
   * the price of keeping the queryable pair queryable: they are the two facts read outside the
   * engine layer — the breadcrumb, `resolveContextLimit` and `budgetFor` — and burying them in JSON
   * on SQLite makes them unfilterable for no gain.
   */
  async open(args: {
    threadId: string;
    accountId: string;
    engineConfig: EngineConfig;
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
        engine: args.engineConfig.kind,
        model: args.engineConfig.model,
        engineConfig: args.engineConfig,
        ordinal: (last?.ordinal ?? 0) + 1,
        ...(args.seededFromId === undefined ? {} : { seededFromId: args.seededFromId }),
        ...(args.handoff === undefined ? {} : { handoff: args.handoff }),
      },
    });
  }

  /**
   * The SDK's own id, learned from the first frame of the first turn. Needed to resume.
   *
   * Named arguments because both are opaque ids of the same type: our row id and the engine's, which
   * are exactly the pair you do not want to transpose — swapping them typechecks, writes a valid
   * string, and only surfaces as a resume that silently starts a new conversation.
   */
  async recordEngineSessionId(args: { sessionId: string; engineSessionId: string }): Promise<void> {
    await this.prismaService.engineSession.update({
      where: { id: args.sessionId },
      data: { engineSessionId: args.engineSessionId },
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
  async setAccount(args: { sessionId: string; accountId: string }): Promise<void> {
    await this.prismaService.engineSession.update({
      where: { id: args.sessionId },
      data: { accountId: args.accountId },
    });
  }

  async end(id: string, endReason: ESessionEndReason): Promise<void> {
    await this.prismaService.engineSession.update({
      where: { id },
      data: { endReason, endedAt: new Date() },
    });
  }

}
