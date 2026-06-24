/**
 * The two-edges-one-brain stimulus model. Everything that reaches Atlas's triage step arrives as a
 * `Stimulus` — one internal currency, two subtypes:
 *
 *  - `ChatStimulus` — duplex. CONTINUES an existing thread. Carries the author and a reply-route so
 *    Atlas can talk back over the same `ChatSurface` (Slack thread, terminal, agent-facing).
 *  - `EventStimulus` — inbound-only. OPENS a new thread in the project's channel. Comes from a
 *    `NotificationSource` (GitHub webhook, generic webhook, later Sentry/PostHog/email). Always
 *    `trust: 'untrusted'` — its body is DATA to triage, never instructions. Carries a `dedupeKey`
 *    (the mechanical pre-harness filter collapses duplicates by it) and a `severity`.
 *
 * A notification never has a conversation of its own — it SEEDS one: the `EventStimulus` opens a
 * thread and ends its job there; every further exchange happens over the `ChatSurface` in that
 * thread. These are in-memory shapes (the triage/intake currency), kept separate from the
 * `atlas_stimuli` persistence row.
 */

/** Trust label. Chat from a known surface is `trusted`; every notification body is `untrusted`. */
export type StimulusTrust = 'trusted' | 'untrusted';

/** Coarse urgency the notification adapter maps from its gateway's payload. */
export type EventSeverity = 'info' | 'warning' | 'critical';

/** Discriminator shared by the persistence row + the in-memory union. */
export type StimulusKind = 'chat' | 'event';

/** Fields common to both subtypes. */
interface BaseStimulus {
  /** Stable id minted at intake (the `atlas_stimuli` PK once persisted). */
  id: string;
  /** The tenant (Slack team id) this stimulus belongs to. */
  orgId: string;
  /** The project (and thus channel) this stimulus routes to. */
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
  /** The thread this message belongs to (`atlas_threads.id`). */
  threadId: string;
  /** Who authored the message — display name + scope id. */
  author: { id: string; displayName: string };
  /** Where Atlas replies: the surface id + the surface-native thread coordinate (e.g. a Slack ts). */
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

/** The intake currency: one brain, two subtypes, discriminated by `kind`. */
export type Stimulus = ChatStimulus | EventStimulus;
