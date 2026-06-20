import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import type { ChatSurface, InboundChatMessage, PostOptions } from './chat-surface.port';
import { emojiToSlackName } from './slack-emoji';
import {
  ATLAS_SLACK_SOCKET_CLIENT,
  ATLAS_SLACK_WEB_CLIENT,
  type SlackSocketClientLike,
  type SlackWebClientLike,
} from './slack.tokens';

const POST_RETRIES = 3;

/** A raw Slack message event the adapter cares about (the subset of fields it reads). */
interface SlackMessageEvent {
  type?: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
}

/**
 * Atlas v2's minimal THREAD-AWARE Slack adapter — the `ChatSurface` for a real Slack channel. The
 * whole point vs. v1's `SlackChatSurface`:
 *
 *  - v1 `post()` always posts top-level (no `thread_ts`) and returns void.
 *    Here `post()` passes `thread_ts` when given and RETURNS the message ts → the caller seeds a
 *    thread (first post) and replies into it (pass that ts back).
 *  - v1 `handleMessageEvent()` explicitly DROPS thread replies (`event.thread_ts && … return`).
 *    Here a thread reply is KEPT and emitted with its `threadTs` populated → Atlas continues the
 *    job's conversation in-thread, duplex.
 *
 * Single-tenant in W1 (one bot token / team). Inbound is fed by a Socket Mode connection; the
 * echo-loop guard drops our own + other bots' messages. The SDK clients arrive via DI tokens so the
 * adapter is testable without real Slack.
 */
@Injectable()
export class AtlasSlackSurface implements ChatSurface, OnApplicationShutdown {
  readonly name = 'slack';
  private readonly logger = new Logger(AtlasSlackSurface.name);
  private readonly subject = new Subject<InboundChatMessage>();
  private selfUserId: string | undefined;
  private teamId = '';
  private connected = false;

  constructor(
    @Optional() @Inject(ATLAS_SLACK_WEB_CLIENT)
    private readonly web: SlackWebClientLike | undefined,
    @Optional() @Inject(ATLAS_SLACK_SOCKET_CLIENT)
    private readonly socket: SlackSocketClientLike | undefined,
  ) {}

  get inbound$(): Observable<InboundChatMessage> {
    return this.subject.asObservable();
  }

  /** True when a Web client is bound (the surface can post). */
  get available(): boolean {
    return !!this.web;
  }

  /**
   * Open the Socket Mode connection and start emitting inbound. Call AFTER subscribers are wired
   * (the bridge subscribes to `inbound$` first), exactly like v1's transport.connect(). No-op when
   * no socket is bound (headless). Resolves the bot's own identity for the echo guard + boot banner.
   */
  async connect(): Promise<{ botUserId?: string; teamId?: string }> {
    if (this.web) {
      try {
        const id = await this.web.auth.test();
        this.selfUserId = id.user_id;
        this.teamId = id.team_id ?? '';
      } catch (err) {
        this.logger.warn(`auth.test failed: ${err}`);
      }
    }
    if (!this.socket) {
      this.logger.log('No Slack socket bound — inbound is inert (post-only).');
      return { botUserId: this.selfUserId, teamId: this.teamId };
    }
    this.socket.on('slack_event', (raw: unknown) => {
      void this.handleEnvelope(raw);
    });
    await this.socket.start();
    this.connected = true;
    this.logger.log(`Atlas Slack surface connected (bot ${this.selfUserId ?? '?'}).`);
    return { botUserId: this.selfUserId, teamId: this.teamId };
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.connected) {
      try {
        await this.socket?.disconnect();
      } catch {
        // already down
      }
    }
  }

  /** Normalize a Socket Mode envelope → a message event, ack it, and emit if it's a real message. */
  private async handleEnvelope(raw: unknown): Promise<void> {
    const envelope = raw as {
      type?: string;
      body?: { team_id?: string; event?: SlackMessageEvent };
      ack?: () => Promise<void>;
    };
    // Ack FIRST — Slack redelivers unacked envelopes.
    try {
      await envelope.ack?.();
    } catch {
      // ignore ack failures
    }
    if (envelope.type !== 'events_api') return;
    const event = envelope.body?.event;
    const teamId = envelope.body?.team_id ?? this.teamId;
    if (event) this.emitInbound(event, teamId);
  }

  /**
   * Emit a Slack message event as an inbound chat message — KEEPING thread replies (the v1 fix). The
   * echo-loop guard drops our own + bot messages and non-plain subtypes.
   */
  emitInbound(event: SlackMessageEvent, teamId: string): void {
    if (!event || event.type !== 'message') return;
    if (event.bot_id || event.subtype === 'bot_message') return;
    if (event.subtype) return; // message_changed, channel_join, …
    if (!event.user || !event.channel || !event.ts) return;
    if (this.selfUserId && event.user === this.selfUserId) return;

    const text = (event.text ?? '').trim();
    if (!text) return;

    // A thread reply has thread_ts !== ts; a thread ROOT message has thread_ts === ts (or none). We
    // carry threadTs whenever the message lives in a thread, so the brain routes it to the job.
    const threadTs =
      event.thread_ts && event.thread_ts !== event.ts ? event.thread_ts : undefined;

    this.subject.next({
      id: event.ts,
      authorId: event.user,
      authorName: event.user, // W1: raw id; directory resolution is a later workstream
      text,
      teamId,
      channel: event.channel,
      ...(threadTs ? { threadTs } : {}),
      ts: new Date(Number(event.ts) * 1000),
    });
  }

  /**
   * Post a message to a channel — into a thread when `opts.threadTs` is set, top-level otherwise.
   * Returns the posted message's ts (the thread handle), or undefined when no client is bound.
   */
  async post(channel: string, text: string, opts: PostOptions = {}): Promise<string | undefined> {
    if (!this.web) {
      this.logger.warn(`No Slack Web client — dropping post to ${channel}`);
      return undefined;
    }
    let lastErr: unknown;
    for (let attempt = 1; attempt <= POST_RETRIES; attempt++) {
      try {
        const res = await this.web.chat.postMessage({
          channel,
          text,
          ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
          ...(opts.blocks ? { blocks: opts.blocks } : {}),
        });
        return res.ts;
      } catch (err) {
        lastErr = err;
        await sleep(500 * attempt);
      }
    }
    throw lastErr;
  }

  /** Add an emoji reaction to a message by ts. */
  async react(channel: string, ts: string, emoji: string): Promise<void> {
    if (!this.web) return;
    try {
      await this.web.reactions.add({ channel, timestamp: ts, name: emojiToSlackName(emoji) });
    } catch (err) {
      if (isSlackErr(err, 'already_reacted')) return;
      throw err;
    }
  }

  /** Remove an emoji reaction by ts. */
  async unreact(channel: string, ts: string, emoji: string): Promise<void> {
    if (!this.web) return;
    try {
      await this.web.reactions.remove({ channel, timestamp: ts, name: emojiToSlackName(emoji) });
    } catch (err) {
      if (isSlackErr(err, 'no_reaction')) return;
      throw err;
    }
  }
}

/** Match a Slack Web API error by its `data.error` code. */
function isSlackErr(err: unknown, code: string): boolean {
  const e = err as { data?: { error?: string } };
  return e?.data?.error === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
