import { Injectable, Logger } from "@nestjs/common";
import { EHarnessVariant } from "../domain/message.js";
import { bindingFor } from "../domain/role-engine.js";
import type { SessionRef } from "../domain/seam.js";
import { EThreadStatus } from "../generated/prisma/enums.js";
import type { EngineSession, Job, Thread } from "../generated/prisma/client.js";
import { JobRepository } from "../store/job.repository.js";
import { MessageRepository } from "../store/message.repository.js";
import { SessionRepository } from "../store/session.repository.js";
import { ThreadRepository } from "../store/thread.repository.js";
import { TurnRepository } from "../store/turn.repository.js";
import { AccountUsageService } from "./account-usage.service.js";
import { ContextFolderService } from "./context-folder.service.js";
import { ConversationStoreRegistry } from "./conversation-store.registry.js";
import { PhaseBriefService } from "./phase-brief.service.js";
import { SessionManagerService } from "./session-manager.service.js";
import { TurnRunnerService } from "./turn-runner.service.js";

export type OpenConversation = {
  job: Job;
  thread: Thread;
  session: EngineSession;
  sessions: SessionRef[];
  cwd: string;
  contextRoot: string;
  /** Closed threads are a RECORD, not a place to work. Nothing to do with other terminals. */
  closed: boolean;
  /**
   * The phase's standing instructions, on every turn's system prompt. Resolved once here rather than
   * per turn in the runner: it costs a read, and a thread never moves phase.
   */
  brief: string;
};

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);
  private open?: OpenConversation;

  constructor(
    private readonly jobRepository: JobRepository,
    private readonly threadRepository: ThreadRepository,
    private readonly sessionRepository: SessionRepository,
    private readonly messageRepository: MessageRepository,
    private readonly turnRepository: TurnRepository,
    private readonly sessionManagerService: SessionManagerService,
    private readonly turnRunnerService: TurnRunnerService,
    private readonly contextFolderService: ContextFolderService,
    private readonly accountUsageService: AccountUsageService,
    private readonly phaseBriefService: PhaseBriefService,
    private readonly stores: ConversationStoreRegistry,
  ) {}

  get current(): OpenConversation | undefined {
    return this.open;
  }

  async openJob(job: Job, cwd: string): Promise<OpenConversation> {
    const thread = job.activeThreadId
      ? await this.threadRepository.findById(job.activeThreadId)
      : null;
    if (!thread) throw new Error(`job ${job.id} has no active thread`);
    return this.openThread(job, thread, cwd);
  }

  async openThread(
    job: Job,
    thread: Thread,
    cwd: string,
  ): Promise<OpenConversation> {
    // A closed thread is a RECORD, not a place to work. Asking the session manager for a current
    // session would end up minting a fresh one — a junk row on finished history, and an account
    // demanded of someone who only wanted to read a transcript. So it reopens its last session.
    //
    // This is the ONLY thing that makes a conversation unwritable. It used to share the flag with a
    // per-session lock held by another terminal, which is why taking a job over left you looking at
    // a live thread labelled read-only whose composer silently swallowed everything you typed.
    const closed = thread.status === EThreadStatus.closed;
    const session = closed
      ? await this.lastSession(thread)
      : await this.sessionManagerService.currentSession(thread);

    const [messages, sessions, lastTurn] = await Promise.all([
      this.messageRepository.listForThread(thread.id),
      this.sessionRepository.refsForThread(thread.id),
      this.turnRepository.lastForThread(thread.id),
    ]);

    // hydrate(), never reset(): this same path is how a RUNNING thread is reopened, and a reset
    // would blank a working agent's spinner, live tail and steer queue.
    const store = this.stores.hydrate(thread.id, messages, closed, lastTurn);
    if (!this.turnRunnerService.busy(thread.id)) {
      store.setContextPercent(session.contextPercent);
    }
    // Nothing will be billed to a closed thread's account, so there is nothing to poll for.
    if (!closed)
      this.accountUsageService.kick({
        accountId: session.accountId,
        threadId: thread.id,
      });

    const contextRoot = this.contextFolderService.ensure(job.id);
    const brief = await this.phaseBriefService.forPhase({
      job,
      phaseId: thread.phaseId,
    });

    this.open = {
      job,
      thread,
      session,
      sessions,
      cwd,
      contextRoot,
      closed,
      brief: brief.instructions,
    };
    return this.open;
  }

  /**
   * Atlas's opening words in a thread nobody has opened yet — how a new job stops landing on a blank
   * conversation.
   *
   * Deliberately NOT `sendHarness()`: at job creation there is no open conversation to speak into,
   * and there must not be one. The turn is fired against the thread directly, so the agent is
   * already charting by the time the human walks in, and what it was told is a real `seed` message
   * in the transcript rather than an assertion.
   */
  async seedThread(args: {
    job: Job;
    thread: Thread;
    cwd: string;
  }): Promise<void> {
    const brief = await this.phaseBriefService.forPhase({
      job: args.job,
      phaseId: args.thread.phaseId,
    });
    const session = await this.sessionManagerService.currentSession(args.thread);

    // Not awaited: `run()` resolves when the TURN does, and creating a job must not block behind an
    // agent thinking. A failure lands in the thread's store as an error block, where the human looks.
    void this.turnRunnerService
      .run({
        thread: args.thread,
        session,
        prompt: brief.opening,
        harnessVariant: EHarnessVariant.seed,
        brief: brief.instructions,
        cwd: args.cwd,
      })
      .catch((error: unknown) => {
        this.logger.error(`seed turn failed: ${String(error)}`);
      });
  }

  async send(text: string): Promise<void> {
    const open = this.requireOpen();
    if (open.closed) return;

    if (this.turnRunnerService.busy(open.thread.id)) {
      this.turnRunnerService.steer({
        thread: open.thread,
        session: open.session,
        text,
      });
      return;
    }

    await this.turnRunnerService.run({
      thread: open.thread,
      session: open.session,
      prompt: text,
      brief: open.brief,
      cwd: open.cwd,
    });
    await this.refreshSessions();
  }

  /**
   * Atlas speaking into the open conversation in its own name — a brief, a hand-off, a transition.
   *
   * Deliberately NOT the steer path `send()` takes when a turn is running. A steer arrives mid-turn
   * as unattributed text, which is exactly the impersonation the envelope exists to prevent; `run()`
   * queues behind the in-flight turn instead, so an injection lands at a turn boundary. That is also
   * where every harness event already happens — rotation, phase advance — for the same reason: no
   * work in flight is lost to it.
   */
  async sendHarness(args: {
    variant: EHarnessVariant;
    text: string;
  }): Promise<void> {
    const open = this.requireOpen();
    // Read-only means another instance owns this session; it will speak for the harness, not us.
    if (open.closed) return;

    await this.turnRunnerService.run({
      thread: open.thread,
      session: open.session,
      prompt: args.text,
      harnessVariant: args.variant,
      brief: open.brief,
      cwd: open.cwd,
    });
    await this.refreshSessions();
  }

  async interrupt(text?: string): Promise<void> {
    const open = this.requireOpen();
    await this.turnRunnerService.interrupt(open.thread.id);
    if (text && text.trim().length > 0) {
      await this.turnRunnerService.run({
        thread: open.thread,
        session: open.session,
        prompt: text,
        brief: open.brief,
        cwd: open.cwd,
      });
    }
  }

  get busy(): boolean {
    return (
      this.open !== undefined &&
      this.turnRunnerService.busy(this.open.thread.id)
    );
  }

  async rotate(
    endReason: Parameters<SessionManagerService["rotateSession"]>[2],
  ): Promise<void> {
    const open = this.requireOpen();
    const next = await this.sessionManagerService.rotateSession(
      open.thread,
      open.session,
      endReason,
    );
    this.open = { ...open, session: next };
    await this.refreshSessions();
  }

  breadcrumbEngine(): { engine: string; model: string } {
    const open = this.requireOpen();
    const binding = bindingFor(open.thread.role);
    return { engine: binding.engine.kind, model: open.session.model };
  }

  /**
   * Forget which conversation is open. Nothing is persisted and nothing is unlocked — which
   * terminal is driving is a per-JOB claim on disk now, not a per-session row, so leaving a
   * conversation says nothing about whether you have left the job.
   *
   * A turn in flight is undisturbed on purpose: leaving a running thread is the point.
   */
  async release(): Promise<void> {
    this.open = undefined;
  }

  async leave(): Promise<void> {
    await this.release();
  }

  /**
   * Stop everything this job has in flight, and let go of it.
   *
   * What a displaced tile does when its job is taken. Navigating away is NOT enough: `←` out of a
   * running conversation deliberately leaves the agent working, so a tile that only popped would
   * keep streaming into a transcript the other terminal is now also writing — two writers, neither
   * of them on screen. The interrupt is the whole point; the navigation is cosmetic beside it.
   *
   * Every thread, not just the open one: a job runs several at once, and the tile taking over is
   * about to drive all of them.
   */
  async abandonJob(jobId: string): Promise<void> {
    const threads = await this.threadRepository.listForJob(jobId);
    await Promise.all(
      threads.map((thread) => this.turnRunnerService.interrupt(thread.id)),
    );
    if (this.open?.job.id === jobId) await this.release();
  }

  async evict(
    jobIds: readonly string[],
    threadIds: readonly string[],
  ): Promise<void> {
    if (threadIds.some((threadId) => this.turnRunnerService.busy(threadId))) {
      throw new Error(
        "an agent is still working in this job — interrupt it first",
      );
    }
    this.stores.forget(threadIds);
    if (this.open && jobIds.includes(this.open.job.id)) await this.release();
  }

  /**
   * The last session a closed thread ran on. `activeSessionId` still points at it — closing a thread
   * ends its session rather than unlinking it, which is what makes the transcript readable after.
   */
  private async lastSession(thread: Thread): Promise<EngineSession> {
    const session = thread.activeSessionId
      ? await this.sessionRepository.findById(thread.activeSessionId)
      : null;
    if (!session)
      throw new Error("this thread was closed before it ever ran — nothing to read");
    return session;
  }

  private async refreshSessions(): Promise<void> {
    if (!this.open) return;
    this.open = {
      ...this.open,
      sessions: await this.sessionRepository.refsForThread(this.open.thread.id),
    };
  }

  private requireOpen(): OpenConversation {
    if (!this.open) throw new Error("no conversation is open");
    return this.open;
  }
}
