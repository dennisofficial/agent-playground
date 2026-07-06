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

// Type-only import of the turn-chunk shape (chunk-vocabulary has no runtime deps, so no import cycle).
import type { TurnChunk } from '../stimulus/chunk-vocabulary';

/** Trust label. Chat from a known surface is `trusted`; every notification body is `untrusted`. */
export type StimulusTrust = 'trusted' | 'untrusted';

/**
 * SEED RENDER COMMAND — how a system-seeded turn appears as a visible transcript row. The console mirrors
 * the agent's transcript, so EVERY seed the brain receives must be legible; this is the per-seed strategy
 * the central `persistSeedRow` executes (Command pattern — the seed site describes the row, one handler
 * performs it). Cases:
 *   - a descriptor  → a `system_notice` (or `untrusted`) pill with a short curated `label`;
 *   - `'skip'`      → the seed's content already has a durable row elsewhere (an event body, a compaction
 *                     summary), so no row is added;
 *   - absent        → a GENERIC fallback pill, so a newly-added seed can never be silently invisible.
 * The `chunkKey` is content-stable so live delivery, the boot re-delivery sweep, and re-drive collapse to
 * ONE row. In-memory only — never persisted on the stimulus itself.
 */
export type SeedRow =
  | 'skip'
  | {
      /** Short, human-readable pill text — NOT the raw engine prompt/instruction. */
      label: string;
      /** Content-stable dedup key (e.g. `seed:secret:<jobId>:<name>`). */
      chunkKey: string;
      /** Row kind. Defaults to `system_notice`; `untrusted` for fenced external data. */
      kind?: 'system_notice' | 'untrusted';
      /** `<untrusted>` provenance/severity, surfaced on the untrusted pill. */
      untrustedSource?: string;
      severity?: string;
    };

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
  replyRoute: { surfaceId: string; jobRef: string };
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
  /**
   * DELIVERY SEED (file variant): the `requestId` of the `request_file` card whose uploaded file THIS
   * seed confirms. The delivery turn stamps that card `delivered_at` on its success tail (at-least-once,
   * tied to the exact confirmation-carrying seed). In-memory only — never persisted. Undefined otherwise.
   */
  seedFileId?: string;
  /**
   * RESET-VERIFY SEED: a synthetic continuation kicked by `maybeHonorSandboxReset` after a `reset_sandbox`
   * teardown, whose sole job is to guarantee a turn happens so Atlas verifies on the fresh container. The
   * actual verify instruction rides the reset-notice (consumed by whichever turn cold-attaches first), so
   * this turn is a NO-OP when the notice was already consumed by an earlier turn — see the guard at the top
   * of `runChatTurnInner`. In-memory only — never persisted.
   */
  seedResetVerify?: boolean;
  /**
   * HALT-WAKE SEED (ADR 0004 Phase 3): a synthetic wake delivering a halted build thread's terminal record to
   * the brain to triage. Carries the halted `threadId` + the `gen` (`halt_fix_attempts`) captured when the
   * wake fired. Stamped `halt_waked_at` on the turn's SUCCESS TAIL (generation-keyed CAS) — so a swallowed
   * engine error / guard-hit / detach leaves the halt un-waked, letting the periodic + boot sweeps retry it
   * (at-least-once, matching `seedQuestionId`'s delivered-on-success semantics). In-memory only.
   */
  seedHaltWake?: { threadId: string; gen: number };
  /**
   * SEED RENDER COMMAND (see {@link SeedRow}): how this seed turn shows in the transcript. Read by the
   * central `persistSeedRow` at turn intake. In-memory only — never persisted on the stimulus row.
   */
  seedRow?: SeedRow;
  /**
   * COMPACTION turn: a synthetic, Atlas-authored turn (enqueued e.g. by `dispatch_build`) whose ONLY job is
   * to compact the brain session — summarize the current (fat) session into a lean handoff, then null the
   * session id + stash the summary as the next turn's seed. It runs a summarization engine turn, NOT a
   * normal conversational turn: `runChatTurnInner` branches to the compaction path and returns early. Runs
   * on the serialized turn queue (so nothing interleaves) and, being Atlas-authored, skips the passive-
   * awareness drain. In-memory only — never persisted.
   */
  compact?: boolean;
  /**
   * Optional structured card payload persisted alongside `body` on the `messages` row (render-only — the
   * brain still triages `body`, never `card`). E.g. a batch of review comments renders as a styled card
   * in the web client while `body` carries the formatted markdown Atlas reads.
   */
  card?: Record<string, unknown>;
  /**
   * Optional pre-built turn-chunk envelope (chunk-vocabulary). ADVISORY + in-memory only: it drives how
   * the engine string is framed for THIS turn (e.g. the coalesced fresh-turn path sets one `<user>` chunk
   * per pending message so each keeps its own attribution). `body` stays the CLEAN/authoritative string;
   * a replayed stimulus (no `chunks`) reconstructs the `<user>` wrap from the author fields at turn time,
   * so recovery renders identically. Never persisted.
   */
  chunks?: TurnChunk[];
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
  /**
   * OPTIONAL correlation hint for routing to an EXISTING job's brain instead of seeding a new thread —
   * a GitHub event on a PR/branch Atlas already owns (CI failure, merge conflict, review comment) should
   * reach that job's session, not open a fresh event thread. Intake matches `branch` against a job's
   * `feature_branch`/`current_branch` and `prNumber` against its `pr_number`. Absent → seed as before.
   */
  correlation?: { branch?: string | null; prNumber?: number | null };
}
