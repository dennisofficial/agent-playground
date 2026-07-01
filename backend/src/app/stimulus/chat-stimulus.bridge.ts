import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Subscription } from 'rxjs';
import { Repository } from 'typeorm';
import type { ChatStimulus } from '../domain';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity } from '../persistence/entities';
import {
  CHAT_SURFACE,
  type ChatSurface,
  type InboundChatMessage,
} from '../surface';
import { StimulusIntake } from './stimulus-intake.service';

/**
 * The CHAT EDGE → `ChatStimulus` mapper. Subscribes to the bound `ChatSurface.inbound$` and turns each
 * inbound human message into a `ChatStimulus` that CONTINUES a thread, then hands it to the intake seam.
 * Counterpart to the `NotificationSource` adapters that OPEN a thread; both converge on `StimulusIntake`.
 *
 * Addressing: the web surface addresses by the REAL thread id (`msg.threadTs` carries `threads.id`)
 * and the repo coordinate (`msg.channel` carries `repo_id`). A message referencing an existing thread
 * continues it; an unaddressed message opens a chat-origin thread on the repo (the web path always
 * addresses, so that branch is effectively the agent-surface/test path). No channel indirection.
 *
 * Boot order: subscribe to `inbound$` FIRST, then connect the surface — so no early message is missed.
 *
 * NOTE — the chat-intake indirection is slated for rework alongside the `Stimulus` union; see
 * `../ARCHITECTURE.md` §7.
 */
@Injectable()
export class ChatStimulusBridge implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ChatStimulusBridge.name);
  private sub?: Subscription;

  constructor(
    @Inject(CHAT_SURFACE) private readonly surface: ChatSurface,
    private readonly intake: StimulusIntake,
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly threads: Repository<JobEntity>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Subscribe BEFORE connecting so the first inbound isn't dropped.
    this.sub = this.surface.inbound$.subscribe((msg) => {
      void this.onInbound(msg).catch((err) =>
        this.logger.error(`chat intake failed for ${msg.id}: ${err}`),
      );
    });

    // Connect the surface if it exposes a connect() (an agent-facing one may not). Done here, after the
    // subscription is live.
    const connectable = this.surface as ChatSurface & {
      connect?: () => Promise<unknown>;
    };
    if (typeof connectable.connect === 'function') {
      try {
        await connectable.connect();
      } catch (err) {
        this.logger.warn(`surface connect failed (inbound may be inert): ${err}`);
      }
    }
  }

  onApplicationShutdown(): void {
    this.sub?.unsubscribe();
  }

  /** Resolve the thread, build the `ChatStimulus`, hand it to intake. */
  async onInbound(msg: InboundChatMessage): Promise<void> {
    const thread = await this.resolveThread(msg);
    if (!thread) {
      this.logger.debug(
        `inbound for an unknown thread/repo (org ${msg.orgId}, repo ${msg.channel}) — ignored`,
      );
      return;
    }

    const stimulus: ChatStimulus = {
      id: '', // minted by the store on persist
      orgId: thread.org_id,
      repoId: thread.repo_id,
      kind: 'chat',
      trust: 'trusted',
      body: msg.text,
      threadId: thread.id,
      author: { id: msg.authorId, displayName: msg.authorName },
      replyRoute: {
        surfaceId: this.surface.name,
        threadRef: thread.id,
      },
      receivedAt: msg.ts,
      ...(msg.seed ? { seed: true } : {}),
      ...(msg.seedQuestionId ? { seedQuestionId: msg.seedQuestionId } : {}),
    };
    await this.intake.intakeChat(stimulus);
  }

  /**
   * The `threads` row this message belongs to. `msg.threadTs` carries the real thread id when the
   * caller addresses an existing thread (the web operator path always does). Otherwise open a fresh
   * chat-origin thread on the repo (`msg.channel` = repo_id).
   */
  private async resolveThread(msg: InboundChatMessage): Promise<JobEntity | null> {
    if (msg.threadTs) {
      const existing = await this.threads.findOne({ where: { id: msg.threadTs } });
      if (existing) return existing;
    }
    if (!msg.orgId || !msg.channel) return null;
    return this.threads.save(
      this.threads.create({
        org_id: msg.orgId,
        repo_id: msg.channel,
        origin: 'chat',
        surface_thread_ref: null,
        title: null,
      }),
    );
  }
}
