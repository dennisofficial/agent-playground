/**
 * driver / leg-rotation-watch — the per-batch-turn latch that watches a builder session's LIVE main-agent
 * context occupancy and fires SOFT once, then a REMINDER on each further +delta of growth, as the window fills.
 * This is the observation core of Leg rotation (one build Thread → many sequential engine sessions / "Legs"): a
 * rotation ends the fat Leg's session and starts a fresh one seeded with a structured handoff. See the plan
 * `~/.claude/plans/context-rot-is-real-immutable-sedgewick.md`.
 *
 * DESIGN NOTES (why it is shaped this way):
 *  • ONE soft threshold, then DELTA reminders — NO hard threshold and NO forced rotation. The soft nudge asks the
 *    builder to author a handoff and yield; if it keeps going, a reminder re-fires every +`reminderDeltaTokens`.
 *    Rotation happens ONLY when the builder self-authors a handoff (`record_leg_handoff`) — the watch never forces
 *    it. (Historically a HARD threshold force-ran a read-only fallback handoff; removed — operator decision.)
 *  • ABSOLUTE token thresholds, NOT a fraction of the window. Builders run the 1M-context beta, so these are
 *    ROTATE points with headroom to author the handoff — not a truncation wall. Declared in the JIT rule catalog
 *    (`prompt-kit/jit`, d4) because effective reasoning context degrades well below 150k (NoLiMa / RULER); Stage 0
 *    logs real occupancy.
 *  • POSITIVE-SIGNAL ONLY. `contextTokens == null` events (Codex / master-review turns, whose SDK surfaces no
 *    per-call occupancy) are ignored and NEVER latch — so those turns can never trip a rotation. This polarity
 *    is INVERTED vs the brain's compaction gate (which compacts on unknown occupancy); getting it wrong would
 *    nudge a Codex turn, which is nonsensical.
 *  • LEVEL-LATCH debounce. Occupancy is ~monotonic within a turn and the engine emits a `usage` event per
 *    main-agent round-trip, so a level-latch (fire each level at most once) is the right debounce — no timers.
 *    A turn that jumps several deltas past soft fires only the HIGHEST level crossed. The FIRST fire is always
 *    SOFT (the initial ask); every later level increase is a REMINDER.
 *
 * Pure and dependency-free so it unit-tests without Nest/DB.
 */
import { ROTATION_REMINDER_DELTA_TOKENS, ROTATION_SOFT_TOKENS } from '../prompt-kit/jit';

/** Which kind of context-pressure signal just fired. */
export type LegRotationSignalPhase = 'soft' | 'reminder';

/** Absolute context-token knobs. Both are config; see {@link resolveRotationThresholds}. */
export interface LegRotationThresholds {
  /** SOFT nudge: context is getting high — finish the current major phase, then author the handoff. */
  softTokens: number;
  /** After SOFT, re-fire a REMINDER on each further +this many tokens of growth. */
  reminderDeltaTokens: number;
}

/**
 * Operator-chosen defaults (150k soft, +25k per reminder, on the 1M window). R&D — expect to tune downward.
 * Sourced from the `leg-rotation` JIT rule (the catalog is now the one place these are declared).
 */
export const DEFAULT_ROTATION_SOFT_TOKENS = ROTATION_SOFT_TOKENS;
export const DEFAULT_ROTATION_REMINDER_DELTA_TOKENS = ROTATION_REMINDER_DELTA_TOKENS;

/** What a threshold crossing carries to the (later-stage) nudge injection + visible-row persist. */
export interface LegRotationSignal {
  /** `soft` on the first crossing, `reminder` on every later level increase. */
  phase: LegRotationSignalPhase;
  /** 0 for the soft nudge; the (monotonic) delta-level for a reminder (informational — drives the dedup key). */
  reminderIndex: number;
  /** The main-agent context occupancy that tripped it. */
  contextTokens: number;
  /** The model's resolved context window, when the usage event carried one. */
  contextLimit: number | null;
}

/** The subset of an engine `usage` event this watch reads (kept structural so it needs no engine import). */
export interface OccupancyEvent {
  contextTokens?: number | null;
  contextLimit?: number | null;
  /**
   * The spawning Task id when this frame is a SUBAGENT's own occupancy; UNSET for the main agent. A
   * subagent runs in its own, separate context window that cannot be rotated, so its occupancy must never
   * drive Leg rotation — {@link LegRotationWatch.observe} rejects any frame that carries this.
   */
  parentToolUseId?: string;
}

/**
 * The mutable per-Leg run state the driver threads through one build turn: filled DURING the turn by the live
 * watch (`softReached`, `peakTokens`) and the `record_leg_handoff` host tool (`handoff`), then read AFTER the turn
 * to decide whether to rotate. One instance per Leg (reset between Legs of the same batch).
 */
export interface LegRotationRunState {
  /** The handoff the builder SELF-authored via `record_leg_handoff`, or null if it never called it. */
  handoff: string | null;
  /** Whether the live watch ever latched (soft or beyond) this Leg — informational/logging only. */
  softReached: boolean;
  /** The peak main-agent context occupancy observed this Leg (persisted as the closing Leg's peak). */
  peakTokens: number | null;
}

/** A fresh, empty {@link LegRotationRunState} (no handoff, nothing latched). */
export function freshLegRotationState(): LegRotationRunState {
  return { handoff: null, softReached: false, peakTokens: null };
}

/**
 * Resolve the rotation thresholds. No longer env-overridable (d4 removed `ROTATION_SOFT_TOKENS` /
 * `ROTATION_REMINDER_DELTA_TOKENS`) — the declared JIT-rule values are the only source now.
 */
export function resolveRotationThresholds(): LegRotationThresholds {
  return {
    softTokens: DEFAULT_ROTATION_SOFT_TOKENS,
    reminderDeltaTokens: DEFAULT_ROTATION_REMINDER_DELTA_TOKENS,
  };
}

/**
 * Per-batch-turn occupancy latch. Construct one per build turn; feed it each engine `usage` event via
 * {@link observe}. It invokes `onSignal` at most once per level: SOFT on the first crossing, then a REMINDER on
 * each further +`reminderDeltaTokens` of growth.
 */
export class LegRotationWatch {
  /** The highest delta-level latched so far, or -1 before soft. Level 0 = soft; level k≥1 = k-th reminder band. */
  private firedLevel = -1;

  constructor(
    private readonly thresholds: LegRotationThresholds,
    private readonly onSignal: (signal: LegRotationSignal) => void,
  ) {}

  /** Whether the watch has latched at all this Leg (soft or beyond). */
  get softReached(): boolean {
    return this.firedLevel >= 0;
  }

  /**
   * Feed one occupancy sample. Ignores unknown-occupancy events (Codex — never latches) and anything below the
   * soft threshold. Fires SOFT on the first latch and a REMINDER on each later level increase; idempotent per
   * level (a sample that jumps several deltas fires the highest level only).
   */
  observe(evt: OccupancyEvent): void {
    if (evt.parentToolUseId != null) return; // subagent's own window — a separate context that can't be rotated
    const tokens = evt.contextTokens;
    if (tokens == null) return; // positive-signal only — never nudge a Codex/unknown-occupancy turn
    if (tokens < this.thresholds.softTokens) return; // below soft — nothing to do yet
    const contextLimit = evt.contextLimit ?? null;
    const level = Math.floor((tokens - this.thresholds.softTokens) / this.thresholds.reminderDeltaTokens);
    if (level <= this.firedLevel) return; // already at/above this level — nothing new
    const isFirst = this.firedLevel < 0;
    this.firedLevel = level;
    this.onSignal({
      phase: isFirst ? 'soft' : 'reminder',
      reminderIndex: isFirst ? 0 : level,
      contextTokens: tokens,
      contextLimit,
    });
  }
}
