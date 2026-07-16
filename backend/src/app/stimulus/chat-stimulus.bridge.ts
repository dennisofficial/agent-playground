import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Subscription } from 'rxjs';
import { Repository } from 'typeorm';
import type { UserMessage } from '../domain';
import { JobBootstrapService } from '../job-bootstrap';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity } from '../persistence/entities';
import {
  CHAT_SURFACE,
  type ChatSurface,
  type InboundChatMessage,
} from '../surface/chat-surface.port';
import { StimulusIntake } from './stimulus-intake.service';

/**
 * The CHAT EDGE → `UserMessage` mapper. Subscribes to the bound `ChatSurface.inbound$` and turns each
 * inbound human message into a typed `Message` that CONTINUES a thread, then hands it to the intake seam
 * (which persists it and hands the brain a `TurnEnvelope`). Counterpart to the `NotificationSource`
 * adapters that route an event to a thread; both converge on `StimulusIntake`.
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
export class ChatStimulusBridge
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(ChatStimulusBridge.name);
  private sub?: Subscription;

  constructor(
    @Inject(CHAT_SURFACE) private readonly surface: ChatSurface,
    private readonly intake: StimulusIntake,
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
    // Bootstraps a freshly-opened chat-origin thread's ONE planning thread group + thread (d7: `thread_group_id` is never
    // null). @Optional (trailing) so the existing direct-construction unit tests (positional args) keep
    // compiling without a trailing argument.
    @Optional() private readonly jobBootstrap?: JobBootstrapService,
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
        this.logger.warn(
          `surface connect failed (inbound may be inert): ${err}`,
        );
      }
    }
  }

  onApplicationShutdown(): void {
    this.sub?.unsubscribe();
  }

  /** Resolve the thread, build the `Message`, hand it to intake. */
  async onInbound(msg: InboundChatMessage): Promise<void> {
    const thread = await this.resolveThread(msg);
    if (!thread) {
      this.logger.debug(
        `inbound for an unknown thread/repo (org ${msg.orgId}, repo ${msg.channel}) — ignored`,
      );
      return;
    }

    // A seed-flavored inbound (answered question, uploaded file, provided secret, or a generic system
    // seed) is a brain-side direct caller with an already-rendered body + `seedRow` on hand, not one of
    // the 17 typed internal-seed variants — it goes through the legacy generic-seed path, which keeps
    // `recordChatStimulus`'s own `'seed'`-fallback mechanism live for these callers (see
    // `StimulusIntake.intakeLegacySeed`'s doc comment).
    if (msg.seed) {
      await this.intake.intakeLegacySeed(
        {
          orgId: thread.org_id,
          repoId: thread.repo_id,
          jobId: thread.id,
          body: msg.text,
          seedRow: msg.seedRow,
          seedQuestionId: msg.seedQuestionId,
          seedFileId: msg.seedFileId,
          seedSecretId: msg.seedSecretId,
          seedQuestionIds: msg.seedQuestionIds,
          seedFileIds: msg.seedFileIds,
          seedSecretIds: msg.seedSecretIds,
          priority: msg.priority,
          card: msg.card,
        },
        {
          author: { id: msg.authorId, displayName: msg.authorName },
          replyRoute: { surfaceId: this.surface.name, jobRef: thread.id },
        },
      );
      return;
    }

    // `id: ''` is minted by the store on persist; `receivedAt` is an ISO string on the union (`msg.ts` is
    // a Date).
    const message: UserMessage = {
      type: 'user',
      trust: 'trusted',
      id: '',
      orgId: thread.org_id,
      repoId: thread.repo_id,
      jobId: thread.id,
      receivedAt: msg.ts.toISOString(),
      body: msg.text,
      author: { id: msg.authorId, displayName: msg.authorName },
    };

    await this.intake.intakeChat(message, {
      author: { id: msg.authorId, displayName: msg.authorName },
      replyRoute: { surfaceId: this.surface.name, jobRef: thread.id },
      // A PLAIN (non-seed) inbound can still carry a render-only card (an operator's attachments_card /
      // review_comments_card send) — `UserMessage` has no `card` field (data-model.md: `attachments`
      // supersedes it), so it rides the transport instead of being dropped. `msg.priority` mirrors it for
      // the same reason.
      card: msg.card,
      priority: msg.priority,
    });
  }

  /**
   * The `threads` row this message belongs to. `msg.threadTs` carries the real thread id when the
   * caller addresses an existing thread (the web operator path always does). Otherwise open a fresh
   * chat-origin thread on the repo (`msg.channel` = repo_id).
   */
  private async resolveThread(
    msg: InboundChatMessage,
  ): Promise<JobEntity | null> {
    if (msg.threadTs) {
      const existing = await this.jobs.findOne({ where: { id: msg.threadTs } });
      if (existing) return existing;
    }
    if (!msg.orgId || !msg.channel) return null;
    const thread = await this.jobs.save(
      this.jobs.create({
        org_id: msg.orgId,
        repo_id: msg.channel,
        origin: 'chat',
        surface_thread_ref: null,
        title: null,
      }),
    );
    // Bootstrap the thread's ONE planning thread group + thread — d7: `thread_group_id` is never null, even for a
    // chat-origin thread that never gets a plan proposed.
    await this.jobBootstrap?.ensurePlanningThreadGroup(thread.id, msg.orgId);
    return thread;
  }
}
