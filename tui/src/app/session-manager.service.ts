import { Injectable, Logger } from "@nestjs/common";
import { bindingFor } from "../domain/role-engine.js";
import {
  EAccountStatus,
  ESessionEndReason,
  type EThreadRole,
} from "../generated/prisma/enums.js";
import type { EngineSession, Thread } from "../generated/prisma/client.js";
import { AccountRepository } from "../store/account.repository.js";
import { JobRepository } from "../store/job.repository.js";
import { SessionRepository } from "../store/session.repository.js";
import { ThreadRepository } from "../store/thread.repository.js";
import { ROLE_GROUP } from "../domain/role-engine.js";

export class NoAccountError extends Error {
  constructor(engine: string) {
    super(`no usable ${engine} account — add one before running a turn`);
    this.name = "NoAccountError";
  }
}

@Injectable()
export class SessionManagerService {
  private readonly logger = new Logger(SessionManagerService.name);

  constructor(
    private readonly threadRepository: ThreadRepository,
    private readonly sessionRepository: SessionRepository,
    private readonly accountRepository: AccountRepository,
    private readonly jobRepository: JobRepository,
  ) {}

  async openThread(jobId: string, role: EThreadRole): Promise<Thread> {
    const group = await this.jobRepository.groupFor(jobId, ROLE_GROUP[role]);
    const thread = await this.threadRepository.create({
      groupId: group.id,
      role,
    });
    await this.jobRepository.setActiveThread(jobId, thread.id);
    return thread;
  }

  async currentSession(thread: Thread): Promise<EngineSession> {
    if (thread.activeSessionId) {
      const existing = await this.sessionRepository.findById(
        thread.activeSessionId,
      );
      if (existing && existing.endedAt === null) return existing;
    }
    return this.openSession(thread);
  }

  async openSession(
    thread: Thread,
    seed?: { seededFromId: string; handoff?: string },
  ): Promise<EngineSession> {
    const binding = bindingFor(thread.role);
    const account = await this.pickAccount(binding.engine);
    const session = await this.sessionRepository.open({
      threadId: thread.id,
      accountId: account.id,
      engine: binding.engine,
      model: binding.model,
      ...(seed
        ? {
            seededFromId: seed.seededFromId,
            ...(seed.handoff ? { handoff: seed.handoff } : {}),
          }
        : {}),
    });
    await this.threadRepository.setActiveSession(thread.id, session.id);
    return session;
  }

  async rotateSession(
    thread: Thread,
    current: EngineSession,
    endReason: ESessionEndReason,
    handoff?: string,
  ): Promise<EngineSession> {
    await this.sessionRepository.end(current.id, endReason);
    this.logger.log(
      `rotating session ${current.ordinal} of thread ${thread.id} (${endReason})`,
    );
    return this.openSession(thread, {
      seededFromId: current.id,
      ...(handoff === undefined ? {} : { handoff }),
    });
  }

  async closeThread(thread: Thread): Promise<void> {
    if (thread.activeSessionId) {
      await this.sessionRepository.end(
        thread.activeSessionId,
        ESessionEndReason.thread_closed,
      );
    }
    await this.threadRepository.close(thread.id);
  }

  private async pickAccount(engine: string): Promise<{ id: string }> {
    const accounts = await this.accountRepository.listForEngine(
      engine as never,
    );
    const usable = accounts.filter((a) => a.status === EAccountStatus.active);
    if (usable.length === 0) throw new NoAccountError(engine);

    const sorted = [...usable].sort(
      (a, b) => (a.fiveHourUtil ?? 101) - (b.fiveHourUtil ?? 101),
    );
    // `?? 101` sorts unknown-usage accounts LAST among actives — see above.
    return sorted[0] as { id: string };
  }
}
