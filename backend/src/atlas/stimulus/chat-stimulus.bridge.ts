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
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import { AtlasChannel, AtlasThread } from '../persistence/entities';
import {
  CHAT_SURFACE,
  type ChatSurface,
  type InboundChatMessage,
} from '../surface';
import { StimulusIntake } from './stimulus-intake.service';

/**
 * The CHAT EDGE → `ChatStimulus` mapper. Subscribes to the bound `ChatSurface.inbound$` and turns each
 * inbound human message into a `ChatStimulus` that CONTINUES an existing thread (the duplex half of
 * the model), then hands it to the intake seam. Counterpart to the `NotificationSource` adapters that
 * OPEN a thread; both converge on the same `StimulusIntake`.
 *
 * Threading + routing:
 *  - The Slack `channel` maps to an `atlas_channels.surface_channel_ref` → the project. A message in an
 *    unregistered channel is ignored (Atlas only listens where it's bound).
 *  - A reply carrying `threadTs` continues the `atlas_threads` row whose `surface_thread_ref` == that
 *    ts. A NEW top-level message (no `threadTs`) opens a chat-origin thread on the fly (a human
 *    starting a conversation) — its `surface_thread_ref` is the message's own ts.
 *  - The `replyRoute` lets the brain talk back over the SAME surface/thread (surfaceId = the surface
 *    name, threadRef = the Slack thread root ts).
 *
 * Boot order mirrors v1's bridge: subscribe to `inbound$` FIRST, then connect the surface — so no
 * early message is missed. Zero v1 imports.
 */
@Injectable()
export class ChatStimulusBridge implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ChatStimulusBridge.name);
  private sub?: Subscription;

  constructor(
    @Inject(CHAT_SURFACE) private readonly surface: ChatSurface,
    private readonly intake: StimulusIntake,
    @InjectRepository(AtlasChannel, ATLAS_CONNECTION)
    private readonly channels: Repository<AtlasChannel>,
    @InjectRepository(AtlasThread, ATLAS_CONNECTION)
    private readonly threads: Repository<AtlasThread>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Subscribe BEFORE connecting so the first inbound isn't dropped.
    this.sub = this.surface.inbound$.subscribe((msg) => {
      void this.onInbound(msg).catch((err) =>
        this.logger.error(`chat intake failed for ${msg.id}: ${err}`),
      );
    });

    // Connect the surface if it exposes a connect() (the Slack adapter does; an agent-facing one may
    // not). Done here, after the subscription is live.
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

  /** Resolve channel→project + thread, build the `ChatStimulus`, hand it to intake. */
  async onInbound(msg: InboundChatMessage): Promise<void> {
    const channel = await this.channels.findOne({
      where: { team_id: msg.teamId, surface_channel_ref: msg.channel },
    });
    if (!channel) {
      this.logger.debug(`inbound in unregistered channel ${msg.channel} (team ${msg.teamId}) — ignored`);
      return;
    }

    const thread = await this.resolveThread(channel, msg);
    const stimulus: ChatStimulus = {
      id: '', // minted by the store on persist
      teamId: msg.teamId,
      projectId: channel.project_id,
      kind: 'chat',
      trust: 'trusted',
      body: msg.text,
      threadId: thread.id,
      author: { id: msg.authorId, displayName: msg.authorName },
      replyRoute: {
        surfaceId: this.surface.name,
        threadRef: thread.surface_thread_ref ?? msg.id,
      },
      receivedAt: msg.ts,
    };
    await this.intake.intakeChat(stimulus);
  }

  /**
   * Find the `atlas_threads` row this message belongs to. A `threadTs` reply continues the thread
   * whose `surface_thread_ref` matches; a top-level message opens a fresh chat-origin thread keyed by
   * its own ts (so subsequent replies in that Slack thread resolve back to it).
   */
  private async resolveThread(
    channel: AtlasChannel,
    msg: InboundChatMessage,
  ): Promise<AtlasThread> {
    const surfaceThreadRef = msg.threadTs ?? msg.id;
    const existing = await this.threads.findOne({
      where: {
        team_id: channel.team_id,
        project_id: channel.project_id,
        surface_thread_ref: surfaceThreadRef,
      },
    });
    if (existing) return existing;

    return this.threads.save(
      this.threads.create({
        team_id: channel.team_id,
        project_id: channel.project_id,
        origin: 'chat',
        surface_thread_ref: surfaceThreadRef,
        title: null,
      }),
    );
  }
}
