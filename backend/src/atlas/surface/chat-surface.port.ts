import type { Observable } from 'rxjs';

/**
 * DI token a hosting app binds its surface adapter to
 * (`{ provide: CHAT_SURFACE, useExisting: AtlasSlackSurface }`).
 */
export const CHAT_SURFACE = Symbol('ATLAS_CHAT_SURFACE');

/**
 * The Atlas v2 thread-aware `ChatSurface` port — a clean-room rewrite of v1's `chat-surface.port.ts`
 * with FIRST-CLASS THREADING, the thing v1's adapter structurally can't do.
 *
 * Key differences from v1:
 *  - `post` carries an optional `threadTs` and RETURNS the posted message's `ts` (v1 returns void) —
 *    so the caller can seed a thread (the first post's ts) and reply into it (pass that ts back).
 *  - `inbound$` INCLUDES thread replies and carries their `threadTs` (v1 drops thread replies).
 *
 * This realizes the v2 threading model: notifications announce in the main timeline, each job's
 * chatter lives in a thread off the announcement, and the duplex exchange happens IN that thread.
 */

/** A human (or external-system) message arriving FROM the surface. */
export interface InboundChatMessage {
  /** Surface-native id (Slack message ts). */
  id: string;
  /** Stable author id (e.g. a Slack user id). */
  authorId: string;
  /** Display name. */
  authorName: string;
  text: string;
  /** The tenant (Slack team id). */
  teamId: string;
  /** Surface-native channel coordinate (e.g. a Slack channel id 'C042'). */
  channel: string;
  /**
   * The root ts of the thread this message belongs to, when it's a thread reply. Undefined for a
   * top-level (timeline) message. THIS is what v1 throws away — it's how Atlas knows which job's
   * conversation a reply continues.
   */
  threadTs?: string;
  ts: Date;
}

/** Options for an outbound post. */
export interface PostOptions {
  /**
   * Post as a reply in this thread (the thread root's ts). Omit to post top-level in the timeline.
   * The returned ts of a top-level post becomes the threadTs for subsequent replies.
   */
  threadTs?: string;
  /** Optional Block Kit blocks (e.g. the approval card). `text` is still the notification fallback. */
  blocks?: Array<Record<string, unknown>>;
  /**
   * The tenant (Slack team id) to post AS — selects that workspace's bot token in the multi-workspace
   * surface. Omit → the single env-token fallback client (single-tenant dev / headless). A post with a
   * teamId that has no installed token (and no fallback) is dropped, never mis-routed to another team.
   */
  teamId?: string;
  /**
   * Optional opaque metadata carried by this post — surface-specific consumers may use it to type
   * events (e.g. the web surface attaches it to `WebOutboundMessage.meta` so SSE subscribers can
   * distinguish build-phase engine events from conversational chat messages). Other surfaces ignore it.
   */
  meta?: Record<string, unknown>;
}

/**
 * The thread-aware chat-surface port — duplex group-chat semantics. The brain/driver is agnostic to
 * WHERE the chat lives: the Slack adapter speaks to a real channel; an agent-facing adapter (W6) lets
 * a test driver send to Atlas and read replies. Both honor threading.
 */
export interface ChatSurface {
  readonly name: string; // 'slack' | 'agent' | 'web'
  /** Inbound human messages — INCLUDING thread replies (each carrying its `threadTs`). */
  readonly inbound$: Observable<InboundChatMessage>;
  /**
   * Deliver a message to a channel (optionally into a thread). Returns the posted message's `ts` —
   * the handle a caller uses to seed/continue a thread. Returns undefined if the surface couldn't
   * post (e.g. no client bound).
   */
  post(channel: string, text: string, opts?: PostOptions): Promise<string | undefined>;
  /** Add an emoji reaction to a message (by its ts) in a channel; `teamId` selects the workspace token. */
  react(channel: string, ts: string, emoji: string, teamId?: string): Promise<void>;
  /** Remove an emoji reaction this surface added (clears a transient marker). */
  unreact(channel: string, ts: string, emoji: string, teamId?: string): Promise<void>;
  /**
   * OPTIONAL — repaint a previously posted message (e.g. replace the approval card with a verdict
   * card after the operator rules). The Slack adapter implements this via `chat.update`; the web
   * adapter mutates the outbox entry and re-emits on `outbound$`; the agent adapter is a no-op.
   * Surfaces that do NOT support live edits may omit this method — callers check with `canUpdate`.
   */
  update?(
    channel: string,
    ts: string,
    args: { text?: string; blocks?: Array<Record<string, unknown>> },
    teamId?: string,
  ): Promise<void> | void;
}
