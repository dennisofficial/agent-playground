/**
 * The intake shapes. Every inbound request reaches the system as one of two — there is NO unified
 * `Stimulus` union or router any more; each goes straight to the one brain per thread:
 *
 *  - `ChatStimulus` — duplex. CONTINUES an existing thread; handled by that thread's own Claude Code
 *    session (the "thread brain"). Carries the author + a reply-route so the system can post back over
 *    the same `ChatSurface` (the web operator console, or the in-process agent surface in tests).
 *  - `EventStimulus` — inbound-only. SEEDS a new thread from a `NotificationSource` (GitHub/generic
 *    webhook, later Sentry/PostHog/email). Always `trust: 'untrusted'` — its body is DATA, never
 *    instructions. Carries a `dedupeKey` (the mechanical dedup/rate-limit filter collapses duplicates
 *    by it) and a `severity`. It is delivered to the seeded thread's brain as a HARNESS message (a
 *    server-initiated turn), mechanically like a human's first message but visibly not human-authored.
 *
 * These are in-memory shapes, kept separate from the `stimuli` persistence row (which still carries a
 * `kind` discriminator column + the event-dedup partial index). See `../ARCHITECTURE.md` §7.
 */

/** Trust label. Chat from a known surface is `trusted`; every notification body is `untrusted`. */
export type StimulusTrust = 'trusted' | 'untrusted';

/** Coarse urgency the notification adapter maps from its gateway's payload. */
export type EventSeverity = 'info' | 'warning' | 'critical';

/** Fields common to both subtypes. */
interface BaseStimulus {
  /** Stable id minted at intake (the `stimuli` PK once persisted). */
  id: string;
  /** The owning organization (`org_id`). */
  orgId: string;
  /** The repo this stimulus routes to (`repo_id`). */
  repoId: string;
  /** The raw text/body Atlas triages. */
  body: string;
  /** When the stimulus was received. */
  receivedAt: Date;
}

/**
 * A chat message continuing an existing thread — duplex, so it carries who said it and how to reply
 * (the surface + coordinate the `ChatSurface` posts back to).
 */
export interface ChatStimulus extends BaseStimulus {
  kind: 'chat';
  trust: 'trusted';
  /** The thread this message belongs to (`threads.id`). */
  jobId: string;
  /** Who authored the message — display name + scope id. */
  author: { id: string; displayName: string };
  /** Where the system replies: the surface id + the surface-native thread coordinate (the web thread ref). */
  replyRoute: { surfaceId: string; threadRef: string };
  /**
   * SYSTEM SEED: a system-injected context turn (e.g. an `ask_question` answer framed as
   * `<system_notification>`), not a human chat message. Runs a brain turn but is NOT persisted as a
   * `messages` row — so it never renders as an operator chat bubble.
   */
  seed?: boolean;
  /**
   * DELIVERY SEED: the `questionId` of the `ask_question` card whose operator answer THIS seed delivers.
   * The delivery turn stamps that card `deliveredAt` on its success tail (at-least-once bookkeeping tied
   * to the exact answer-carrying seed), and the decision tools resolve it as the answered card to attach.
   * In-memory only — never persisted. Undefined for non-answer turns.
   */
  seedQuestionId?: string;
}

/**
 * A notification event opening a NEW thread — inbound-only (no reply path of its own), untrusted,
 * dedupe-keyed, severity-tagged. The owning `NotificationSource` adapter derives `source`,
 * `dedupeKey`, `severity`, and project routing from its gateway-specific payload before this lands.
 */
export interface EventStimulus extends BaseStimulus {
  kind: 'event';
  trust: 'untrusted';
  /** The thread this event seeded (`threads.id`) — the brain it's delivered to as a harness message. */
  jobId: string;
  /** The gateway that produced it, e.g. 'github' | 'webhook' | 'sentry' | 'posthog'. */
  source: string;
  /** Collapse key for the mechanical dedup/rate-limit filter (e.g. the grouped issue/run id). */
  dedupeKey: string;
  /** Severity the adapter mapped from its payload. */
  severity: EventSeverity;
}
