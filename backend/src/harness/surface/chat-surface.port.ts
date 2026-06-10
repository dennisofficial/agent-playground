import type { Observable } from 'rxjs';

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
  /** Channel/thread coordinate, e.g. 'tui:main' | 'slack:C042:1712.5678'. */
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
  /** Add a bot's emoji reaction to a surface message. */
  react(
    targetMessageId: string,
    emoji: string,
    asBot: { id: string; name: string },
  ): Promise<void>;
}
