/**
 * The intake currency. Every inbound request reaches the system as a `Stimulus` — two subtypes:
 *
 *  - `ChatStimulus` — duplex. CONTINUES an existing thread; handled by that thread's own Claude Code
 *    session (the "thread brain"). Carries the author + a reply-route so the system can post back over
 *    the same `ChatSurface` (the web operator console, or the in-process agent surface in tests).
 *  - `EventStimulus` — inbound-only. SEEDS a new thread from a `NotificationSource` (GitHub/generic
 *    webhook, later Sentry/PostHog/email). Always `trust: 'untrusted'` — its body is DATA, never
 *    instructions. Carries a `dedupeKey` (the mechanical dedup/rate-limit filter collapses duplicates
 *    by it) and a `severity`.
 *
 * These are in-memory shapes, kept separate from the `stimuli` persistence row.
 *
 * NOTE — slated for rework: the unified `Stimulus` union + `StimulusRouter` demux + the event-only
 * `EventTriageService` are a leftover from the single-central-brain era. There is no central brain now —
 * each thread is its own session. The intended direction is to make an event the *opening message* to a
 * spawned thread's brain (keeping the mechanical guards). See `../ARCHITECTURE.md` §7.
 */

/** Trust label. Chat from a known surface is `trusted`; every notification body is `untrusted`. */
export type StimulusTrust = 'trusted' | 'untrusted';

/** Coarse urgency the notification adapter maps from its gateway's payload. */
export type EventSeverity = 'info' | 'warning' | 'critical';

/** Discriminator shared by the persistence row + the in-memory union. */
export type StimulusKind = 'chat' | 'event';

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
  threadId: string;
  /** Who authored the message — display name + scope id. */
  author: { id: string; displayName: string };
  /** Where the system replies: the surface id + the surface-native thread coordinate (the web thread ref). */
  replyRoute: { surfaceId: string; threadRef: string };
}

/**
 * A notification event opening a NEW thread — inbound-only (no reply path of its own), untrusted,
 * dedupe-keyed, severity-tagged. The owning `NotificationSource` adapter derives `source`,
 * `dedupeKey`, `severity`, and project routing from its gateway-specific payload before this lands.
 */
export interface EventStimulus extends BaseStimulus {
  kind: 'event';
  trust: 'untrusted';
  /** The gateway that produced it, e.g. 'github' | 'webhook' | 'sentry' | 'posthog'. */
  source: string;
  /** Collapse key for the mechanical dedup/rate-limit filter (e.g. the grouped issue/run id). */
  dedupeKey: string;
  /** Severity the adapter mapped from its payload. */
  severity: EventSeverity;
}

/** The intake currency: two subtypes, discriminated by `kind`. */
export type Stimulus = ChatStimulus | EventStimulus;
