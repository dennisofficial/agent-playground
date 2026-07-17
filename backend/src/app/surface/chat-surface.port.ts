import type { SeedRow } from '@shared/domain/seed-row';
import type { AgentMessage } from '@shared/prompt-kit/message';
import type { Observable } from 'rxjs';

import { renderChunk } from '@shared/stimulus/chunk-vocabulary';

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
  /**
   * SYSTEM SEED: when true, this inbound is a system-injected context line (e.g. an `ask_question`
   * answer framed as `<system_notification>`), NOT a human chat message. The intake runs the brain turn
   * but does NOT persist it as a `messages` row, so it never renders as an operator chat bubble.
   */
  seed?: boolean;
  /**
   * DELIVERY SEED: when this seed delivers an operator's answer to a specific `ask_question` card, the
   * card's id (`questionId`). The delivery turn stamps THIS card `deliveredAt` on success — tying the
   * delivered-stamp to the exact seed that carried the answer (so unrelated turns can't prematurely
   * stamp it, and crash recovery re-seeds precisely). Undefined for non-answer seeds.
   */
  seedQuestionId?: string;
  /**
   * DELIVERY SEED (file variant): when this seed delivers a confirmation that the operator uploaded a
   * `request_file` file, the file card's id (`requestId`). The delivery turn stamps THIS card
   * `delivered_at` on success — same at-least-once bookkeeping as `seedQuestionId`. Undefined otherwise.
   */
  seedFileId?: string;
  /**
   * DELIVERY SEED (secret variant): when this seed delivers a confirmation that the operator provided a
   * `request_secret` value, the secret card's id (`requestId`). The delivery turn stamps THIS card
   * `delivered_at` on success — same at-least-once bookkeeping as `seedQuestionId`. Undefined otherwise.
   */
  seedSecretId?: string;
  /**
   * BATCH DELIVERY SEED: the arrays of card ids a SINGLE combined `answer-batch` seed delivers — the
   * plural of `seedQuestionId`/`seedFileId`/`seedSecretId`. Its lone delivery turn stamps EVERY listed
   * card delivered on success (at-least-once). Undefined for a single-card seed.
   */
  seedQuestionIds?: string[];
  seedFileIds?: string[];
  seedSecretIds?: string[];
  /** SEED RENDER COMMAND — how this seed shows in the transcript (see `TurnEnvelope.seedRow`). */
  seedRow?: SeedRow;
  /** Delivery priority for the durable queue. Absent preserves the default `now` behavior. */
  priority?: 'now' | 'queue' | 'later';
  /**
   * Optional structured card payload to persist alongside this message (render-only — the brain still
   * reads `text`, never `card`). E.g. the review-comments batch renders as a styled card in the web
   * client while the formatted markdown in `text` is what Atlas actually reads.
   */
  card?: Record<string, unknown>;
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
   * `WebOutboundMessage.meta` so SSE subscribers can distinguish build-step engine events from
   * conversational chat messages.
   */
  meta?: Record<string, unknown>;
}

/** The author stamped on a SYSTEM SEED — a host-originated context turn, NOT a human (drives the
 *  no-awareness-drain + no-bubble semantics; see `seedSystemNotification`). */
export const SYSTEM_SEED_AUTHOR = { id: 'U-SYSTEM', name: 'System' } as const;

/**
 * Wrap host-originated context in the `<system_notice>` envelope the brain reads. A thin shim over the
 * chunk-vocabulary (`renderChunk`) so every host-seed path frames system context as one consistent tag —
 * "this is system context, not a chat message". (Formerly `<system_notification>`; renamed to join the
 * closed tag vocabulary that the web renderer and the brain's system prompt both speak.)
 */
export function wrapSystemNotification(body: AgentMessage): string {
  return renderChunk({ kind: 'system_notice', body });
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
  emitThreadMeta?(channel: string, jobId: string, title: string): void;
  /**
   * Seed the thread's brain with a SYSTEM NOTIFICATION — host-originated context the brain should react
   * to (an answered `ask_question`, a pipeline milestone, an external event). Wraps `body` in
   * `<system_notification>…</system_notification>`, runs ONE brain turn, and is NEVER persisted as a chat
   * message (no operator bubble; it doesn't drain the passive pipeline-awareness buffer either). Returns
   * the synthetic message ts. This ACTIVELY WAKES the brain — reserve it for events worth a turn; for
   * low-priority "where the build stands" FYI prefer the passive `pipeline_awareness` buffer.
   */
  seedSystemNotification?(
    channel: string,
    jobId: string,
    body: AgentMessage,
    opts?: {
      orgId?: string;
      deliveredQuestionId?: string;
      deliveredFileId?: string;
      deliveredSecretId?: string;
      /** BATCH: arrays of card ids a single combined `answer-batch` seed delivers (see the plural
       *  `InboundChatMessage.seedQuestionIds`). Mapped to the plural internal fields downstream. */
      deliveredQuestionIds?: string[];
      deliveredFileIds?: string[];
      deliveredSecretIds?: string[];
      seedRow?: SeedRow;
      /**
       * Routing coordinate — `'main'` (the brain, default) or a build lane (`'thread:<threadId>'`). d4 makes
       * the seed MECHANISM lane-capable; `'main'` (or absent) is byte-identical to before. Build-lane routing
       * is dispatched by the CALLER (`JitHostExecutor` → the build-lane seed path), not inside a surface impl —
       * a surface adapter can't reach the driver seeder without a SurfaceModule↔DriverModule cycle.
       */
      lane?: string;
    },
  ): string;
}
