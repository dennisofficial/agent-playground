import type { Observable } from 'rxjs';
import type { AccumulatedUsage } from '../domain/conductor-events';

/**
 * DI token a hosting app binds its surface adapter to
 * (`{ provide: CHAT_SURFACE, useClass: TuiChatSurface }`).
 */
export const CHAT_SURFACE = Symbol('CHAT_SURFACE');

/** A human (or external-system) message arriving FROM the surface. */
export interface InboundChatMessage {
  /** Surface-native id when available (Slack ts); generated for the TUI. */
  id: string;
  /** Stable author id (e.g. 'dennis' / a Slack user id). */
  authorId: string;
  /** Display name. */
  authorName: string;
  text: string;
  /** The tenant (Slack team id) this message belongs to — sets the room's team on lazy register. */
  teamId: string;
  /** Tenant-qualified channel/thread coordinate, e.g. 'tui:main' | 'slack:T04:C042'. */
  surfaceId: string;
  ts: Date;
}

/** A bot message leaving FOR the surface. */
export interface OutboundChatMessage {
  /** The channel message id (stable; reactions fold onto it). */
  id: string;
  authorBotId: string;
  authorName: string;
  text: string;
  surfaceId: string;
  /** Aggregate token usage accumulated across all billed steps for this post (gate + LLM steps,
   * including costs from prior ignore/ack turns). When present, a Slack surface renders it as a
   * Block Kit context footer; the TUI already shows per-step usage inline. */
  usage?: AccumulatedUsage;
  /** Slack file IDs uploaded via share_artifact — attached to the message after the text post
   * lands, via `chat.update(file_ids)`. Absent when no artifacts were uploaded this turn. */
  fileIds?: string[];
}

/**
 * The chat-surface port — group-chat semantics (messages + reactions), nothing else. The harness is
 * fully agnostic to WHERE the group chat lives: the TUI adapter simulates it locally for dev, the
 * Slack adapter (later) speaks to a real channel, and the conductor/bridge code path is identical.
 * Future trigger sources (CI/CD, email) arrive as additional inbound adapters, not harness changes.
 */
export interface ChatSurface {
  readonly name: string; // 'tui' | 'slack'
  /** Human messages arriving from the surface (later: inbound reactions too). */
  readonly inbound$: Observable<InboundChatMessage>;
  /** Deliver a bot message to the surface. */
  post(msg: OutboundChatMessage): Promise<void>;
  /** Add a bot's emoji reaction to a surface message (channelId = the message's coordinate —
   * surfaces like Slack address reactions by channel + message ts, not by message id alone). */
  react(
    targetMessageId: string,
    emoji: string,
    asBot: { id: string; name: string },
    channelId: string,
  ): Promise<void>;
  /** Remove a bot's emoji reaction (same coordinate semantics as react). Used to clear the
   * transient "composing" marker when a turn ends. */
  unreact(
    targetMessageId: string,
    emoji: string,
    asBot: { id: string; name: string },
    channelId: string,
  ): Promise<void>;
}
