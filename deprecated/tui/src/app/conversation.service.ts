import { Injectable, Logger } from "@nestjs/common";
import type { DraftImage } from "../domain/draft-images.js";
import { EHarnessVariant } from "../domain/message.js";
import { bindingFor } from "../domain/role-engine.js";
import type { EngineSession, Job, Thread } from "../generated/prisma/client.js";
import { JobRepository } from "../store/job.repository.js";
import { MessageRepository } from "../store/message.repository.js";
import { SessionRepository } from "../store/session.repository.js";
import { ThreadRepository } from "../store/thread.repository.js";
import { TurnRepository } from "../store/turn.repository.js";
import { AccountUsageService } from "./account-usage.service.js";
import { ContextFolderService } from "./context-folder.service.js";
import {
  loadConversation,
  syncCursor,
  type ConversationDeps,
  type CursorSync,
  type OpenConversation,
} from "./conversation-open.js";
import { retryLastTurn } from "./conversation-retry.js";
import { ConversationStoreRegistry } from "./conversation-store.registry.js";
import { PhaseBriefService } from "./phase-brief.service.js";
import { SessionManagerService } from "./session-manager.service.js";
import { ThreadSeamService } from "./thread-seam.service.js";
import { TurnRunnerService } from "./turn-runner.service.js";

// Re-exported because this is the door every caller already knocks on: the type moved for length,
// and moving what imports it would have been a rename dressed up as a refactor.
export type { OpenConversation } from "./conversation-open.js";

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
    private readonly threadSeamService: ThreadSeamService,
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
    this.open = await loadConversation(this.deps, { job, thread, cwd });
    return this.open;
  }

  /**
   * Follow the job's cursor: an agent moves it mid-turn, so where the human should be is not where
   * he was when the page mounted. Called from the renderer on the turn runner's signal.
   *
   * `lastCursorThreadId` is the caller's, not ours, and that is the whole mechanism — see
   * `CursorSync`. Null when nothing is open, which is the ordinary answer while browsing.
   */
  async syncCursor(args: {
    lastCursorThreadId: string | null;
  }): Promise<CursorSync | null> {
    const open = this.open;
    if (!open) return null;
    const sync = await syncCursor(this.deps, { ...args, open });
    // A refresh REPLACES what is open — the thread is the same, everything else about it moved.
    if (sync?.refreshed) this.open = sync.refreshed;
    return sync;
  }

  /**
   * Atlas's opening words in a thread nobody has opened yet — how a later phase's first thread stops
   * landing on a blank conversation.
   *
   * Deliberately NOT `sendHarness()`: the thread being seeded is usually not the open one, and at
   * job creation there is no open conversation at all. The turn is fired against the thread
   * directly, so what it was told is a real `seed` message in the transcript rather than an
   * assertion.
   */
  async seedThread(args: {
    job: Job;
    thread: Thread;
    cwd: string;
  }): Promise<void> {
    // Delegated rather than duplicated: the same act happens when a thread hands over to its
    // successor, and one of those two paths would drift the moment the seed grew a section.
    await this.threadSeamService.seed(args);
  }

  async send(text: string, images: readonly DraftImage[] = []): Promise<void> {
    const open = this.requireOpen();
    if (open.closed) return;

    if (this.turnRunnerService.busy(open.thread.id)) {
      this.turnRunnerService.steer({
        thread: open.thread,
        session: open.session,
        text,
      });
      // A steer is words pushed into a turn already in flight, and the SDK's steering channel takes
      // text — there is nowhere on it to put a picture. Said out loud rather than dropped quietly:
      // the words arrive without the image they refer to, and the only thing worse than that is not
      // knowing it happened. The file is still on disk; the token can be pasted into the next turn.
      if (images.length > 0) {
        this.stores
          .for(open.thread.id)
          .notice(
            images.length === 1
              ? "the image did not go with that steer — a running turn takes words only"
              : `${images.length} images did not go with that steer — a running turn takes words only`,
          );
      }
      return;
    }

    await this.turnRunnerService.run({
      thread: open.thread,
      session: open.session,
      prompt: text,
      ...(images.length > 0 ? { images } : {}),
      brief: open.brief,
      tools: open.tools,
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
      tools: open.tools,
      cwd: open.cwd,
    });
    await this.refreshSessions();
  }

  /** The error block's `↻ retry`: the failed turn's prompt, sent again. See `conversation-retry.ts`. */
  async retry(): Promise<void> {
    const fired = await retryLastTurn({
      open: this.requireOpen(),
      turnRunnerService: this.turnRunnerService,
      stores: this.stores,
    });
    if (fired) await this.refreshSessions();
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
        tools: open.tools,
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
   * The injected collaborators as one bundle, for the functions in `conversation-open.ts`. A getter
   * rather than a field so nothing can hold a stale one, and it costs an object literal per call.
   */
  private get deps(): ConversationDeps {
    return {
      jobRepository: this.jobRepository,
      threadRepository: this.threadRepository,
      sessionRepository: this.sessionRepository,
      messageRepository: this.messageRepository,
      turnRepository: this.turnRepository,
      sessionManagerService: this.sessionManagerService,
      turnRunnerService: this.turnRunnerService,
      contextFolderService: this.contextFolderService,
      accountUsageService: this.accountUsageService,
      phaseBriefService: this.phaseBriefService,
      threadSeamService: this.threadSeamService,
      stores: this.stores,
    };
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
