import { Injectable, Logger } from "@nestjs/common";
import { bindingFor } from "../domain/role-engine.js";
import type { SessionRef } from "../domain/seam.js";
import type { EngineSession, Job, Thread } from "../generated/prisma/client.js";
import { JobRepository } from "../store/job.repository.js";
import { MessageRepository } from "../store/message.repository.js";
import { SessionRepository } from "../store/session.repository.js";
import { ThreadRepository } from "../store/thread.repository.js";
import { TurnRepository } from "../store/turn.repository.js";
import { AccountUsageService } from "./account-usage.service.js";
import { ContextFolderService } from "./context-folder.service.js";
import { ConversationStoreRegistry } from "./conversation-store.registry.js";
import { SessionManagerService } from "./session-manager.service.js";
import { TurnRunnerService } from "./turn-runner.service.js";

export type OpenConversation = {
  job: Job;
  thread: Thread;
  session: EngineSession;
  sessions: SessionRef[];
  cwd: string;
  contextRoot: string;
  readOnly: boolean;
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
    const session = await this.sessionManagerService.currentSession(thread);

    const claimed = await this.sessionRepository.claim(session.id);
    if (!claimed)
      this.logger.warn(`session ${session.id} is locked by another instance`);

    const [messages, sessions, lastTurn] = await Promise.all([
      this.messageRepository.listForThread(thread.id),
      this.sessionRepository.refsForThread(thread.id),
      this.turnRepository.lastForThread(thread.id),
    ]);

    const store = this.stores.hydrate(thread.id, messages, !claimed, lastTurn);
    if (!this.turnRunnerService.busy(thread.id)) {
      store.setContextPercent(session.contextPercent);
    }
    this.accountUsageService.kick(session.accountId, thread.id);

    const contextRoot = this.contextFolderService.ensure(job.id);

    this.open = {
      job,
      thread,
      session,
      sessions,
      cwd,
      contextRoot,
      readOnly: !claimed,
    };
    return this.open;
  }

  async send(text: string): Promise<void> {
    const open = this.requireOpen();
    if (open.readOnly) return;

    if (this.turnRunnerService.busy(open.thread.id)) {
      this.turnRunnerService.steer(open.thread, open.session, text);
      return;
    }

    await this.turnRunnerService.run({
      thread: open.thread,
      session: open.session,
      prompt: text,
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
    return { engine: binding.engine, model: open.session.model };
  }

  async release(): Promise<void> {
    if (this.open) await this.sessionRepository.release(this.open.session.id);
    this.open = undefined;
  }

  async leave(): Promise<void> {
    if (!this.open) return;
    if (this.turnRunnerService.busy(this.open.thread.id)) {
      this.open = undefined;
      return;
    }
    await this.release();
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
