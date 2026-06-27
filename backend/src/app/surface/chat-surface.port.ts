import type { Observable } from 'rxjs';

/**
 * DI token a hosting app binds its surface adapter to
 * (`{ provide: CHAT_SURFACE, useExisting: WebSurface }`).
 */
export const CHAT_SURFACE = Symbol('CHAT_SURFACE');

/**
 * The Atlas v2 thread-aware `ChatSurface` port. Atlas talks to people over ONE surface — the web
 * SSE/REST adapter (`WebSurface`) in production, the in-process `AgentChatSurface` in tests. The
 * brain/driver/gates are agnostic to which: they post into a thread and read `inbound$`.
 *
 * Threading model: each job's chatter lives in a thread (`threadTs`); `post` returns the posted
 * message's `ts` so a caller can seed a thread and reply into it, and `inbound$` carries each reply's
 * `threadTs`.
 */

/** A human (or external-system) message arriving FROM the surface. */
export interface InboundChatMessage {
  /** Surface-native id (the message ts). */
  id: string;
  /** Stable author id. */
  authorId: string;
  /** Display name. */
  authorName: string;
  text: string;
  /** The tenant (team id). */
  orgId: string;
  /** Surface-native channel coordinate. */
  channel: string;
  /**
   * The root ts of the thread this message belongs to, when it's a thread reply. Undefined for a
   * top-level (timeline) message — it's how Atlas knows which job's conversation a reply continues.
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
   * The tenant (team id) to post AS — selects that tenant's credentials. Omit → the default tenant.
   */
  orgId?: string;
  /**
   * Optional opaque metadata carried by this post — the web surface attaches it to
   * `WebOutboundMessage.meta` so SSE subscribers can distinguish build-phase engine events from
   * conversational chat messages.
   */
  meta?: Record<string, unknown>;
}

/**
 * The thread-aware chat-surface port — duplex group-chat semantics. The brain/driver is agnostic to
 * WHERE the chat lives: the web adapter speaks to a web client over SSE/REST; an agent-facing adapter
 * lets a test driver send to Atlas and read replies. Both honor threading.
 */
export interface ChatSurface {
  readonly name: string; // 'web' | 'agent'
  /** Inbound human messages — INCLUDING thread replies (each carrying its `threadTs`). */
  readonly inbound$: Observable<InboundChatMessage>;
  /**
   * Deliver a message to a channel (optionally into a thread). Returns the posted message's `ts` —
   * the handle a caller uses to seed/continue a thread. Returns undefined if the surface couldn't
   * post (e.g. no client bound).
   */
  post(channel: string, text: string, opts?: PostOptions): Promise<string | undefined>;
  /**
   * OPTIONAL — repaint a previously posted message (e.g. replace the approval card with a verdict
   * card after the operator rules). The web adapter mutates the outbox entry and re-emits on
   * `outbound$`; the agent adapter is a no-op. Surfaces that do NOT support live edits may omit this.
   */
  update?(
    channel: string,
    ts: string,
    args: { text?: string; blocks?: Array<Record<string, unknown>> },
    orgId?: string,
  ): Promise<void> | void;
  /**
   * OPTIONAL — operator "resume" requests for a job PAUSED on a credential/401 error. The web adapter
   * emits here on `POST /web/resume`; the driver subscribes and re-drives the job. Routing it through
   * the port (rather than injecting the driver into the surface) keeps SurfaceModule and DriverModule
   * acyclic. Surfaces without a resume affordance (e.g. the agent test surface) omit this.
   */
  readonly resumeRequests$?: Observable<{ jobId: string }>;
  /**
   * OPTIONAL — push a live thread-metadata update (e.g. a renamed title) so the client repaints in
   * place without a reload. `channel` is the repo coordinate the SSE stream filters on. The web
   * adapter emits on `threadMeta$`; the agent test surface omits this.
   */
  emitThreadMeta?(channel: string, threadId: string, title: string): void;
}
