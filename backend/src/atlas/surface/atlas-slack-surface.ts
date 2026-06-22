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
import type {
  SlackBlockAction,
  SlackLifecycleEvent,
  SlackViewSubmission,
} from './slack-events';
import type { SlackInstallationStore } from './slack-installation.store';
import {
  ATLAS_SLACK_SOCKET_CLIENT,
  ATLAS_SLACK_WEB_CLIENT,
  ATLAS_SLACK_WEB_CLIENT_FACTORY,
  type SlackSocketClientLike,
  type SlackWebClientFactory,
  type SlackWebClientLike,
} from './slack.tokens';

const POST_RETRIES = 3;

/** A raw Slack event the adapter cares about (the subset of fields it reads). */
interface SlackEvent {
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
 * Atlas v2's MULTI-WORKSPACE thread-aware Slack adapter. Inbound for EVERY installed workspace arrives
 * over the ONE app-level Socket Mode connection (each envelope carries `team_id`); OUTBOUND posts AS the
 * right workspace by resolving that team's bot token from the `SlackInstallationStore` and building a
 * per-token Web client. A single env bot token (if set) is the FALLBACK client for single-tenant dev /
 * headless — so behavior is byte-identical when no installs exist.
 *
 * Beyond the chat duplex (post/inbound$), it fans out:
 *  - `interactive$`     — block-action clicks (approval + onboarding buttons);
 *  - `viewSubmission$`  — modal submissions (secret collection);
 *  - `lifecycle$`       — bot added/removed from a channel + @mentions (the onboarding triggers).
 * These ride the same socket and never enter the stimulus intake.
 */
@Injectable()
export class AtlasSlackSurface implements ChatSurface, OnApplicationShutdown {
  readonly name = 'slack';
  private readonly logger = new Logger(AtlasSlackSurface.name);
  private readonly subject = new Subject<InboundChatMessage>();
  private readonly interactiveSubject = new Subject<SlackBlockAction>();
  private readonly viewSubmissionSubject = new Subject<SlackViewSubmission>();
  private readonly lifecycleSubject = new Subject<SlackLifecycleEvent>();
  /** Per-bot-token Web clients (keyed by token so a re-install with a new token rebuilds the client). */
  private readonly clients = new Map<string, SlackWebClientLike>();
  /** The env fallback bot's own identity (single-tenant dev echo guard / boot banner). */
  private selfUserId: string | undefined;
  private teamId = '';
  private connected = false;

  constructor(
    @Optional() @Inject(ATLAS_SLACK_WEB_CLIENT)
    private readonly web: SlackWebClientLike | undefined,
    @Optional() @Inject(ATLAS_SLACK_SOCKET_CLIENT)
    private readonly socket: SlackSocketClientLike | undefined,
    @Optional() @Inject(ATLAS_SLACK_WEB_CLIENT_FACTORY)
    private readonly webFactory: SlackWebClientFactory | undefined,
    @Optional()
    private readonly installs: SlackInstallationStore | undefined,
  ) {}

  get inbound$(): Observable<InboundChatMessage> {
    return this.subject.asObservable();
  }

  /** Block-action clicks (approval/onboarding buttons). */
  get interactive$(): Observable<SlackBlockAction> {
    return this.interactiveSubject.asObservable();
  }

  /** Modal submissions (secret collection). */
  get viewSubmission$(): Observable<SlackViewSubmission> {
    return this.viewSubmissionSubject.asObservable();
  }

  /** Workspace lifecycle (bot added/removed, @mentions) — the onboarding triggers. */
  get lifecycle$(): Observable<SlackLifecycleEvent> {
    return this.lifecycleSubject.asObservable();
  }

  /** True when SOME client can post (the env fallback, or per-team installs). */
  get available(): boolean {
    return !!this.web || !!(this.installs && this.webFactory);
  }

  /**
   * Resolve the Web client to post AS for a team: that workspace's installed bot token (built once per
   * token), else the env fallback client. Undefined → nothing can post for this team (drop, never
   * mis-route to another workspace).
   */
  private async webFor(teamId?: string): Promise<SlackWebClientLike | undefined> {
    if (teamId && this.installs && this.webFactory) {
      const token = await this.installs.botToken(teamId);
      if (token) {
        let client = this.clients.get(token);
        if (!client) {
          client = this.webFactory(token);
          this.clients.set(token, client);
        }
        return client;
      }
    }
    return this.web;
  }

  /** This team's bot user id (per-workspace install), else the env fallback identity. */
  private async selfFor(teamId: string): Promise<string | undefined> {
    return (await this.installs?.botUserId(teamId)) ?? this.selfUserId;
  }

  /**
   * Open the Socket Mode connection and start emitting. Call AFTER subscribers are wired. No-op when no
   * socket is bound (headless). Resolves the ENV fallback bot's identity (per-workspace identity comes
   * from the installation store at event time).
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
    this.logger.log(`Atlas Slack surface connected (env bot ${this.selfUserId ?? '?'}).`);
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

  /** Normalize a Socket Mode envelope, ack it, and route by type (events / interactive). */
  private async handleEnvelope(raw: unknown): Promise<void> {
    const envelope = raw as {
      type?: string;
      body?: {
        team_id?: string;
        event?: SlackEvent;
        type?: string;
        user?: { id?: string };
        team?: { id?: string };
      };
      ack?: () => Promise<void>;
    };
    // Ack FIRST — Slack redelivers unacked envelopes. For view_submission an empty ack closes the modal.
    try {
      await envelope.ack?.();
    } catch {
      // ignore ack failures
    }

    if (envelope.type === 'interactive') {
      this.routeInteractive(envelope.body as unknown);
      return;
    }
    if (envelope.type !== 'events_api') return;

    const event = envelope.body?.event;
    const teamId = envelope.body?.team_id ?? this.teamId;
    if (!event) return;

    // App removed / token revoked → soft-delete the install so we stop posting as a dead token.
    if (event.type === 'app_uninstalled' || event.type === 'tokens_revoked') {
      await this.installs?.markUninstalled(teamId);
      this.logger.log(`workspace ${teamId} uninstalled/revoked — install soft-deleted`);
      return;
    }

    // Lifecycle (onboarding triggers) — NEVER enter the chat intake.
    if (event.type === 'member_joined_channel' || event.type === 'member_left_channel') {
      const botUserId = await this.selfFor(teamId);
      if (event.user && event.channel && event.user === botUserId) {
        this.lifecycleSubject.next({
          kind: event.type === 'member_joined_channel' ? 'bot_joined' : 'bot_left',
          teamId,
          channel: event.channel,
          actorId: event.user,
        });
      }
      return;
    }
    if (event.type === 'app_mention') {
      if (event.channel) {
        this.lifecycleSubject.next({
          kind: 'mention',
          teamId,
          channel: event.channel,
          ...(event.user ? { actorId: event.user } : {}),
          ...(event.text ? { text: event.text } : {}),
        });
      }
      return;
    }

    // A plain chat message → emit (with this workspace's echo guard).
    const selfUserId = await this.selfFor(teamId);
    this.emitInbound(event, teamId, selfUserId);
  }

  /** Fan an interactive payload to the right Subject (block_actions vs view_submission). */
  private routeInteractive(payload: unknown): void {
    const p = payload as { type?: string };
    if (p?.type === 'block_actions') {
      this.interactiveSubject.next(payload as SlackBlockAction);
    } else if (p?.type === 'view_submission') {
      this.viewSubmissionSubject.next(payload as SlackViewSubmission);
    }
  }

  /**
   * Emit a Slack message event as an inbound chat message — KEEPING thread replies. The echo-loop guard
   * drops our own + bot messages and non-plain subtypes. `selfUserId` is the posting workspace's bot id
   * (defaults to the env fallback identity, which is what the offline specs use).
   */
  emitInbound(event: SlackEvent, teamId: string, selfUserId = this.selfUserId): void {
    if (!event || event.type !== 'message') return;
    if (event.bot_id || event.subtype === 'bot_message') return;
    if (event.subtype) return; // message_changed, channel_join, …
    if (!event.user || !event.channel || !event.ts) return;
    if (selfUserId && event.user === selfUserId) return;

    const text = (event.text ?? '').trim();
    if (!text) return;

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
      surface: this.name,
      ts: new Date(Number(event.ts) * 1000),
    });
  }

  /**
   * Post a message to a channel as `opts.teamId`'s workspace — into a thread when `opts.threadTs` is set.
   * Returns the posted message's ts, or undefined when no client could be resolved (dropped + logged —
   * never posted to the wrong workspace).
   */
  async post(channel: string, text: string, opts: PostOptions = {}): Promise<string | undefined> {
    const web = await this.webFor(opts.teamId);
    if (!web) {
      this.logger.warn(
        `No Slack Web client for team ${opts.teamId ?? '(env)'} — dropping post to ${channel}`,
      );
      return undefined;
    }
    let lastErr: unknown;
    for (let attempt = 1; attempt <= POST_RETRIES; attempt++) {
      try {
        const res = await web.chat.postMessage({
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

  /** Repaint a posted message (e.g. the approval card after a verdict) as `teamId`'s workspace. */
  async update(
    channel: string,
    ts: string,
    args: { text?: string; blocks?: Array<Record<string, unknown>> },
    teamId?: string,
  ): Promise<void> {
    const web = await this.webFor(teamId);
    if (!web) return;
    await web.chat.update({
      channel,
      ts,
      ...(args.text ? { text: args.text } : {}),
      ...(args.blocks ? { blocks: args.blocks } : {}),
    });
  }

  /** Open a modal from a `trigger_id` as `teamId`'s workspace (secret-collection / onboarding modals). */
  async openModal(triggerId: string, view: unknown, teamId?: string): Promise<void> {
    const web = await this.webFor(teamId);
    if (!web) {
      this.logger.warn(`No Slack Web client for team ${teamId ?? '(env)'} — cannot open modal`);
      return;
    }
    await web.views.open({ trigger_id: triggerId, view });
  }

  /** Add an emoji reaction to a message by ts (as `teamId`'s workspace). */
  async react(channel: string, ts: string, emoji: string, teamId?: string): Promise<void> {
    const web = await this.webFor(teamId);
    if (!web) return;
    try {
      await web.reactions.add({ channel, timestamp: ts, name: emojiToSlackName(emoji) });
    } catch (err) {
      if (isSlackErr(err, 'already_reacted')) return;
      throw err;
    }
  }

  /** Remove an emoji reaction by ts (as `teamId`'s workspace). */
  async unreact(channel: string, ts: string, emoji: string, teamId?: string): Promise<void> {
    const web = await this.webFor(teamId);
    if (!web) return;
    try {
      await web.reactions.remove({ channel, timestamp: ts, name: emojiToSlackName(emoji) });
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
