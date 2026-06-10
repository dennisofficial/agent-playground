import { ConductorEventsBus } from '@harness/conductor/conductor-events.bus';
import type {
  ChatSurface,
  InboundChatMessage,
  OutboundChatMessage,
} from '@harness/surface/chat-surface.port';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import type { SocketModeClient } from '@slack/socket-mode';
import type { WebClient } from '@slack/web-api';
import { Observable, Subject } from 'rxjs';
import { SlackDirectoryService } from './slack-directory.service';
import {
  emojiToSlackName,
  extractMentionIds,
  translateInbound,
} from './slack-text';
import { SLACK_SOCKET_MODE_CLIENT, SLACK_WEB_CLIENT } from './slack.tokens';

const SURFACE_PREFIX = 'slack:';
/** Bot-on-bot reactions target harness-minted message ids — remember where we posted each one. */
const POSTED_ID_LRU_MAX = 2_000;
const POST_RETRIES = 3;

/** The shape SocketModeClient hands events_api listeners (`socket.on('message', …)`). */
interface SlackEventEnvelope {
  ack: () => Promise<void>;
  event: {
    type: string;
    subtype?: string;
    bot_id?: string;
    user?: string;
    text?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
  };
}

/**
 * The Slack Socket Mode ChatSurface — the real group chat. One Slack app posts for every employee
 * via `chat.postMessage` `username` overrides (`chat:write.customize`); inbound channel messages
 * become harness messages after mention translation and room registration. v1 scope: top-level
 * channel messages only (thread replies dropped), no Slack DMs (non-`slack:` rooms skipped on
 * post), single-human speaker attribution (`patchStatus({ speaker })` before each emit).
 */
@Injectable()
export class SlackChatSurface implements ChatSurface, OnApplicationShutdown {
  readonly name = 'slack';
  private readonly logger = new Logger(SlackChatSurface.name);
  private readonly subject = new Subject<InboundChatMessage>();
  private selfBotUserId?: string;
  /** Harness-minted message id → where it landed in Slack (insertion-ordered, LRU-bounded). */
  private readonly postedIds = new Map<string, { channel: string; ts: string }>();

  constructor(
    @Inject(SLACK_WEB_CLIENT) private readonly web: WebClient,
    @Inject(SLACK_SOCKET_MODE_CLIENT) private readonly socket: SocketModeClient,
    private readonly directory: SlackDirectoryService,
    private readonly bus: ConductorEventsBus,
  ) {}

  get inbound$(): Observable<InboundChatMessage> {
    return this.subject.asObservable();
  }

  /** Called from main.ts AFTER Nest bootstrap, so the SurfaceBridge is already subscribed to
   * `inbound$` before the first event can arrive. Returns the bot's identity for the boot banner. */
  async connect(): Promise<{ botName: string }> {
    const auth = await this.web.auth.test();
    this.selfBotUserId = auth.user_id;
    this.socket.on('message', (envelope: SlackEventEnvelope) => {
      void this.handleMessageEvent(envelope);
    });
    for (const state of ['connected', 'disconnected', 'reconnecting'] as const) {
      this.socket.on(state, () => this.logger.log(`Socket Mode: ${state}`));
    }
    await this.socket.start();
    return { botName: auth.user ?? 'unknown' };
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.socket.disconnect();
    } catch {
      // already down — nothing to tear down
    }
  }

  /** Inbound pipeline. Ack FIRST (Slack redelivers unacked envelopes), then filter:
   * own/bot messages (the echo-loop guard — our own chat.postMessage posts come back as message
   * events), non-plain subtypes, and thread replies (v1). */
  private async handleMessageEvent(envelope: SlackEventEnvelope): Promise<void> {
    const { ack, event } = envelope;
    try {
      await ack();
    } catch (err) {
      this.logger.warn(`ack failed: ${err}`);
    }
    try {
      if (!event || event.type !== 'message') return;
      if (event.bot_id || event.subtype === 'bot_message') return;
      if (event.subtype) return; // message_changed, channel_join, …
      if (!event.user || !event.channel || !event.ts) return;
      if (this.selfBotUserId && event.user === this.selfBotUserId) return;
      if (event.thread_ts && event.thread_ts !== event.ts) {
        this.logger.debug(`dropping thread reply in ${event.channel} (v1)`);
        return;
      }

      const author = await this.directory.resolveUser(event.user);
      // Pre-resolve mentioned users so the sync translator's cache lookups hit.
      for (const id of extractMentionIds(event.text ?? '')) {
        if (id !== this.selfBotUserId) await this.directory.resolveUser(id);
      }
      const text = translateInbound(event.text ?? '', {
        resolveUser: (id) => this.directory.displayNameOf(id),
        selfBotUserId: this.selfBotUserId,
      }).trim();
      if (!text) return;

      // Room registration MUST precede the emit (first-write-wins project + roster membership).
      await this.directory.ensureChannelRegistered(event.channel, author.authorId);
      // v1 single-human speaker attribution — same semantics as the TUI's `/as`.
      this.bus.patchStatus({ speaker: author.authorId });
      this.subject.next({
        id: event.ts,
        authorId: author.authorId,
        authorName: author.authorName,
        text,
        surfaceId: `${SURFACE_PREFIX}${event.channel}`,
        ts: new Date(Number(event.ts) * 1000),
      });
    } catch (err) {
      this.logger.error(`inbound handling failed: ${err}`);
    }
  }

  /** Deliver a bot message. Non-Slack rooms (e.g. bot-minted `tui:dm:*`) are skipped — the message
   * is already durable in the channel log; Slack DMs are a v2 item. */
  async post(msg: OutboundChatMessage): Promise<void> {
    if (!msg.surfaceId.startsWith(SURFACE_PREFIX)) {
      this.logger.debug(`skipping post to non-slack room ${msg.surfaceId}`);
      return;
    }
    const channel = msg.surfaceId.slice(SURFACE_PREFIX.length);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= POST_RETRIES; attempt++) {
      try {
        const res = await this.web.chat.postMessage({
          channel,
          text: msg.text,
          username: msg.authorName,
        });
        if (res.ts) this.recordPostedId(msg.id, { channel, ts: res.ts });
        return;
      } catch (err) {
        lastErr = err;
        await sleep(500 * attempt);
      }
    }
    throw lastErr;
  }

  /** React on a surface message: a raw Slack ts (human messages ride their native id), or a
   * harness-minted bot-message id resolved through the posted-id LRU. */
  async react(
    targetMessageId: string,
    emoji: string,
    _asBot: { id: string; name: string },
    channelId: string,
  ): Promise<void> {
    if (!channelId.startsWith(SURFACE_PREFIX)) return;
    const posted = this.postedIds.get(targetMessageId);
    const channel = posted?.channel ?? channelId.slice(SURFACE_PREFIX.length);
    const timestamp = posted?.ts ?? targetMessageId;
    if (!/^\d+\.\d+$/.test(timestamp)) {
      // A minted id we never posted (pre-restart message, or a room we skip) — nothing to target.
      this.logger.debug(`no Slack ts for reaction target ${targetMessageId}`);
      return;
    }
    try {
      await this.web.reactions.add({
        channel,
        timestamp,
        name: emojiToSlackName(emoji),
      });
    } catch (err) {
      // One Slack app reacts for every employee — two bots acking with the same emoji is fine.
      if (isSlackError(err, 'already_reacted')) return;
      throw err;
    }
  }

  private recordPostedId(id: string, ref: { channel: string; ts: string }): void {
    this.postedIds.set(id, ref);
    if (this.postedIds.size > POSTED_ID_LRU_MAX) {
      const oldest = this.postedIds.keys().next().value;
      if (oldest !== undefined) this.postedIds.delete(oldest);
    }
  }
}

function isSlackError(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { data?: { error?: string } }).data?.error === code
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
