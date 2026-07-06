/**
 * driver / leg-rotation-watch — the per-batch-turn latch that watches a builder session's LIVE main-agent
 * context occupancy and fires SOFT once, then HARD once, as the window fills. This is the observation core of
 * Leg rotation (one build Thread → many sequential engine sessions / "Legs"): a rotation ends the fat Leg's
 * session and starts a fresh one seeded with a structured handoff. See the plan
 * `~/.claude/plans/context-rot-is-real-immutable-sedgewick.md`.
 *
 * DESIGN NOTES (why it is shaped this way):
 *  • ABSOLUTE token thresholds, NOT a fraction of the window. Builders run the 1M-context beta, so 200k is a
 *    ROTATE point with ~800k of headroom to author the handoff — not a truncation wall. The thresholds are
 *    config knobs (env-overridable) because effective reasoning context degrades well below 150k (NoLiMa /
 *    RULER); Stage 0 logs real occupancy curves so we can lower them from data, not intuition.
 *  • POSITIVE-SIGNAL ONLY. `contextTokens == null` events (Codex / master-review turns, whose SDK surfaces no
 *    per-call occupancy) are ignored and NEVER latch — so those turns can never trip a rotation. This polarity
 *    is INVERTED vs the brain's compaction gate (which compacts on unknown occupancy); getting it wrong would
 *    rotate a Codex turn, which is nonsensical.
 *  • LATCH-BASED debounce. Occupancy is ~monotonic within a turn and the engine emits a `usage` event per
 *    main-agent round-trip, so a level-latch (fire each threshold at most once) is the right debounce — no
 *    timers. A turn that jumps straight past HARD fires HARD only (SOFT is skipped, not replayed).
 *
 * Pure and dependency-free so it unit-tests without Nest/DB. Stage 0 wires it in observation-only (it logs
 * crossings and takes no action); later stages hang the steer + rotation off `onSignal`.
 */

/** The occupancy-pressure level a turn has reached. Ordered `none < soft < hard`. */
export type LegRotationPhase = 'none' | 'soft' | 'hard';

const PHASE_RANK: Record<LegRotationPhase, number> = { none: 0, soft: 1, hard: 2 };

/** Absolute context-token thresholds. Both are config knobs; see {@link resolveRotationThresholds}. */
export interface LegRotationThresholds {
  /** SOFT nudge: context is getting high — finish the current major phase, then author the handoff. */
  softTokens: number;
  /** HARD stop: context-rot territory — author the handoff now and yield. */
  hardTokens: number;
}

/** Operator-chosen defaults (150k soft / 200k hard on the 1M window). R&D — expect to tune downward. */
export const DEFAULT_ROTATION_SOFT_TOKENS = 150_000;
export const DEFAULT_ROTATION_HARD_TOKENS = 200_000;

/** What a threshold crossing carries to the (later-stage) rotation trigger; Stage 0 just logs it. */
export interface LegRotationSignal {
  /** Which threshold just latched. */
  phase: 'soft' | 'hard';
  /** The main-agent context occupancy that tripped it. */
  contextTokens: number;
  /** The model's resolved context window, when the usage event carried one. */
  contextLimit: number | null;
}

/** The subset of an engine `usage` event this watch reads (kept structural so it needs no engine import). */
export interface OccupancyEvent {
  contextTokens?: number | null;
  contextLimit?: number | null;
}

/**
 * The mutable per-Leg run state the driver threads through one build turn: filled DURING the turn by the live
 * watch (`reached`, `peakTokens`) and the `record_leg_handoff` host tool (`handoff`), then read AFTER the turn
 * to decide whether — and how — to rotate. One instance per Leg (reset between Legs of the same batch).
 */
export interface LegRotationRunState {
  /** The handoff the builder SELF-authored via `record_leg_handoff`, or null if it never called it. */
  handoff: string | null;
  /** The highest occupancy threshold the live watch latched this Leg — drives the post-turn safety-net decision. */
  reached: LegRotationPhase;
  /** The peak main-agent context occupancy observed this Leg (persisted as the closing Leg's peak). */
  peakTokens: number | null;
}

/** A fresh, empty {@link LegRotationRunState} (no handoff, nothing latched). */
export function freshLegRotationState(): LegRotationRunState {
  return { handoff: null, reached: 'none', peakTokens: null };
}

/**
 * Resolve the rotation thresholds, honouring `ROTATION_SOFT_TOKENS` / `ROTATION_HARD_TOKENS` env overrides
 * (à la `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`). Invalid / non-positive / soft≥hard values fall back to the
 * defaults so a fat-fingered override can never disable the safety net.
 */
export function resolveRotationThresholds(env: NodeJS.ProcessEnv = process.env): LegRotationThresholds {
  const parse = (raw: string | undefined, fallback: number): number => {
    if (raw == null || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  const softTokens = parse(env.ROTATION_SOFT_TOKENS, DEFAULT_ROTATION_SOFT_TOKENS);
  const hardTokens = parse(env.ROTATION_HARD_TOKENS, DEFAULT_ROTATION_HARD_TOKENS);
  // A soft threshold at or above the hard threshold is nonsensical (soft would never fire before hard) —
  // fall the pair back to the defaults rather than silently swallow the soft nudge.
  if (softTokens >= hardTokens) {
    return { softTokens: DEFAULT_ROTATION_SOFT_TOKENS, hardTokens: DEFAULT_ROTATION_HARD_TOKENS };
  }
  return { softTokens, hardTokens };
}

/**
 * Per-batch-turn occupancy latch. Construct one per build turn; feed it each engine `usage` event via
 * {@link observe}. It invokes `onSignal` at most once per level (SOFT then HARD), escalating monotonically.
 */
export class LegRotationWatch {
  private phase: LegRotationPhase = 'none';

  constructor(
    private readonly thresholds: LegRotationThresholds,
    private readonly onSignal: (signal: LegRotationSignal) => void,
  ) {}

  /** The highest level latched so far (for callers that poll rather than react to `onSignal`). */
  get reached(): LegRotationPhase {
    return this.phase;
  }

  /**
   * Feed one occupancy sample. Ignores unknown-occupancy events (Codex — never latches). Fires HARD (skipping
   * SOFT) if the sample already sits past the hard threshold and nothing has latched yet; otherwise fires SOFT
   * then, on a later sample, HARD. Idempotent per level.
   */
  observe(evt: OccupancyEvent): void {
    const tokens = evt.contextTokens;
    if (tokens == null) return; // positive-signal only — never rotate a Codex/unknown-occupancy turn
    const contextLimit = evt.contextLimit ?? null;
    const target: LegRotationPhase =
      tokens >= this.thresholds.hardTokens ? 'hard' : tokens >= this.thresholds.softTokens ? 'soft' : 'none';
    if (PHASE_RANK[target] <= PHASE_RANK[this.phase]) return; // already at/above this level — nothing new
    this.phase = target;
    // `target` is 'soft' | 'hard' here (we returned above for 'none'), so the signal phase is well-typed.
    this.onSignal({ phase: target as 'soft' | 'hard', contextTokens: tokens, contextLimit });
  }
}
