import { Injectable, Logger } from "@nestjs/common";
import { bindingFor } from "../domain/role-engine.js";
import {
  ESessionEndReason,
  type EEngine,
  type EThreadRole,
} from "../generated/prisma/enums.js";
import type {
  Account,
  EngineSession,
  Thread,
} from "../generated/prisma/client.js";
import { chooseForTurn, noAccountReason } from "../domain/rotation.js";
import { AccountRepository } from "../store/account.repository.js";
import { JobRepository } from "../store/job.repository.js";
import { SessionRepository } from "../store/session.repository.js";
import { ThreadRepository } from "../store/thread.repository.js";

/**
 * There is deliberately no `NoAccountError` any more. Having no usable credential is a STATE a
 * session can be in, not an exceptional event: the schema can hold it (`EngineSession.accountId` is
 * nullable), the conversation renders it, and the next turn asks again. Throwing was how the old
 * shape reported something it had no way to represent — and it threw from inside job creation, so a
 * credential problem cost a permanent half-built job. `noAccountReason` in `domain/rotation.ts` is
 * the sentence; `usableAccount` returning null is the fact.
 */

@Injectable()
export class SessionManagerService {
  private readonly logger = new Logger(SessionManagerService.name);

  constructor(
    private readonly threadRepository: ThreadRepository,
    private readonly sessionRepository: SessionRepository,
    private readonly accountRepository: AccountRepository,
    private readonly jobRepository: JobRepository,
  ) {}

  /**
   * A new thread joins the phase the job is IN — the role does not choose the phase. Phase
   * boundaries are human boundaries, crossed by a confirmed transition; opening a thread never
   * moves the job.
   */
  async openThread(jobId: string, role: EThreadRole): Promise<Thread> {
    const phase = await this.jobRepository.currentPhase(jobId);
    const thread = await this.threadRepository.create({
      phaseId: phase.id,
      role,
    });
    await this.jobRepository.setActiveThread(jobId, thread.id);
    return thread;
  }

  /**
   * The session this thread's next turn runs on, opening one only if it genuinely has none.
   *
   * The re-read is the load-bearing half, and it is there because **a `Thread` in hand is a
   * snapshot, not a live row.** Every path that opens a thread and then seeds it returns the row it
   * created — captured before the seeding turn opened session 1 — and the UI carries that copy into
   * `loadConversation`, which asks this. Trusting the snapshot minted a SECOND session on a thread
   * that already had one, and the damage was visible twice over: the transcript grew a
   * `session 2 · previous leg ended` divider nobody had rotated through (`withSeams` derives a seam
   * from exactly this disagreement), and the human's first message ran on a fresh engine session
   * that had never seen the seed turn.
   *
   * Written as "the pointer I hold did not resolve, so look again" rather than as a null check, so
   * a snapshot taken before a ROTATION is covered by the same statement.
   */
  async currentSession(thread: Thread): Promise<EngineSession> {
    const held = await this.liveSession(thread.activeSessionId);
    if (held) return held;

    const fresh = await this.threadRepository.findById(thread.id);
    if (fresh && fresh.activeSessionId !== thread.activeSessionId) {
      const current = await this.liveSession(fresh.activeSessionId);
      if (current) return current;
    }
    return this.openSession(thread);
  }

  /** A session that is still running, or null — an ended one is history, not somewhere to write. */
  private async liveSession(
    sessionId: string | null,
  ): Promise<EngineSession | null> {
    if (!sessionId) return null;
    const session = await this.sessionRepository.findById(sessionId);
    return session && session.endedAt === null ? session : null;
  }

  async openSession(
    thread: Thread,
    seed?: { seededFromId: string; handoff?: string },
  ): Promise<EngineSession> {
    const binding = bindingFor(thread.role);
    // Null is allowed all the way through: a session may open before any credential exists, and the
    // turn boundary resolves it — see `sessionForTurn`. Opening used to throw here instead, which is
    // why a missing account could destroy a job that had already been written.
    const account = await this.usableAccount(binding.engine.kind);
    const session = await this.sessionRepository.open({
      threadId: thread.id,
      accountId: account?.id ?? null,
      // The whole resolved config is copied onto the row, so editing the role table next month does
      // not retroactively rewrite what last month's sessions actually ran with.
      engineConfig: binding.engine,
      ...(seed
        ? {
            seededFromId: seed.seededFromId,
            ...(seed.handoff ? { handoff: seed.handoff } : {}),
          }
        : {}),
    });
    await this.threadRepository.setActiveSession({
      threadId: thread.id,
      sessionId: session.id,
    });
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

  /**
   * The account a turn on this engine would run on, or null if none can.
   *
   * The decision is pure and lives in `domain/rotation.ts` — actives by headroom, then an `expired`
   * account as a last resort, because that status records one refresh that failed at some past moment
   * rather than a fact about the credential now.
   */
  async usableAccount(engine: EEngine): Promise<Account | null> {
    const accounts = await this.accountRepository.listForEngine(engine);
    return chooseForTurn(accounts);
  }

  /** Why no account could be chosen, as a sentence for whoever has to show it. */
  async whyNoAccount(engine: EEngine): Promise<string> {
    const accounts = await this.accountRepository.listForEngine(engine);
    return noAccountReason({ engine, accounts });
  }
}
