import { EEngine } from '../generated/prisma/enums.js';
import type { UsageWindowKey } from './message.js';

/** `null` is a REAL state, not zero: usage is unknown until a poll or a turn reports one. */
export type UsageWindow = { utilization: number; resetsAt: string | null } | null;

/**
 * `spent` is not "very red", it is a different kind of fact: a window at 100% has no quantity left
 * to report, so the bar and the percent stop being answers and the countdown becomes the only one.
 */
export type MeterBand = 'unknown' | 'normal' | 'warn' | 'hot' | 'red' | 'spent';

export type MeterKey = 'ctx' | 'fiveHour' | 'sevenDay';

/**
 * Thresholds differ per window because the windows mean different things — `ctx` earns attention
 * earliest because you can act on it this second (rotate, hand off), and `wk` latest because a
 * two-thirds-spent week is simply Thursday.
 *
 * `ctx` is read against the rotation BUDGET rather than the physical window (see `budgetFor`), so
 * its `red` sits exactly on 100: the point where the meter turns red is the point where Atlas starts
 * asking for a hand-off, and one number means one thing in two places.
 */
const BANDS: Record<MeterKey, { warn: number; hot: number; red: number }> = {
  ctx: { warn: 60, hot: 85, red: 100 },
  fiveHour: { warn: 65, hot: 82, red: 93 },
  sevenDay: { warn: 70, hot: 86, red: 95 },
};

export function meterBand(key: MeterKey, utilization: number | null): MeterBand {
  if (utilization === null) return 'unknown';
  // `spent` is for windows that REFILL: at 100% they have nothing left to report and the countdown
  // becomes the only answer. A context budget is advisory — 100% is where the nudging starts, not
  // where the session stops — so `ctx` keeps counting and reads `127%` rather than going `full`.
  if (utilization >= 100 && key !== 'ctx') return 'spent';
  const { warn, hot, red } = BANDS[key];
  if (utilization >= red) return 'red';
  if (utilization >= hot) return 'hot';
  if (utilization >= warn) return 'warn';
  return 'normal';
}

/** Anything above `normal` — the bands where the footer has stopped being ambient. */
export function isPressured(band: MeterBand): boolean {
  return band === 'warn' || band === 'hot' || band === 'red' || band === 'spent';
}

/** `2h14m`, `41m`, `now`. */
export function formatCountdown(resetsAt: string | null, now = Date.now()): string {
  if (!resetsAt) return '';
  const ms = new Date(resetsAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`;
}

/** `—` for unknown, never `0%`. Alignment is the style's job, so this returns the bare token. */
export function formatPercent(utilization: number | null): string {
  return utilization === null ? '—' : `${Math.round(utilization)}%`;
}

/**
 * Filled cells, left for the caller to colour — the fill carries the band and the track recedes.
 * A non-zero window always fills at least one: rounding 1% down to an empty bar would draw "barely
 * started" and "unknown" identically.
 */
export function meterFill(utilization: number | null, cells: number): number {
  if (utilization === null || utilization <= 0) return 0;
  return Math.min(cells, Math.max(1, Math.round((utilization / 100) * cells)));
}

export type Meter = { label: string; key: MeterKey; window: UsageWindow };

/** Normalise the SDK's 0..1-or-0..100 utilisation into a percent. */
export function toPercent(utilization: number | undefined): number | null {
  if (utilization == null) return null;
  const percent = utilization <= 1 ? utilization * 100 : utilization;
  return Math.round(Math.min(100, Math.max(0, percent)));
}

export function windowKeyFor(rateLimitType: string | undefined): UsageWindowKey | null {
  switch (rateLimitType) {
    case 'five_hour':
      return 'fiveHour';
    case 'seven_day':
    case 'seven_day_opus':
    case 'seven_day_sonnet':
      return 'sevenDay';
    default:
      return null;
  }
}

const DEFAULT_CONTEXT_LIMIT = 200_000;
const LONG_CONTEXT_LIMIT = 1_000_000;

/**
 * MEASURED off `result.modelUsage[…].contextWindow`: `claude-opus-5` reports 1000000,
 * `claude-haiku-4-5` reports 200000. An allowlist rather than a default because the penalty is
 * asymmetric — guessing 1M for a 200k model reads the meter five times too low.
 */
const LONG_CONTEXT_MODELS = [
  /^claude-opus-(?:5|4-[678])/,
  /^claude-sonnet-(?:5|4-6)/,
  /^claude-(?:fable|mythos)-5/,
];

export function resolveContextLimit(model: string | undefined): number {
  if (!model) return DEFAULT_CONTEXT_LIMIT;
  if (model.includes('[1m]')) return LONG_CONTEXT_LIMIT;
  return LONG_CONTEXT_MODELS.some((re) => re.test(model))
    ? LONG_CONTEXT_LIMIT
    : DEFAULT_CONTEXT_LIMIT;
}

/**
 * Codex reports its window only on `turn.completed`, and the number MOVES remotely — legacy pinned
 * `272_000` and had no way to notice when that stopped being true. So this is a fallback for the
 * first turn of a Codex session and nothing more: `budgetFor` takes a `contextLimit`, and the engine
 * passes the one the token-count event actually reported the moment it has one.
 */
const CODEX_FALLBACK_LIMIT = 272_000;

export type Budget = {
  /** Where nudging starts, and what the `ctx` meter reads 100% against. */
  soft: number;
  /** Where nudging becomes every-turn. NOT a cut — the only forced rotation is the wall. */
  hard: number;
};

/**
 * The rotation budget, keyed by MODEL — because degradation is a property of the model, not of the
 * job (design 06 §5). A role inherits its budget through its engine binding, so retuning after a
 * model upgrade is one edit here.
 *
 * **These are seeds, not measurements.** Design 06 §3 argued 180K/300K for the Opus class from
 * first principles — every turn re-sends the transcript, so a 200K session burns the rate-limit
 * windows ~4× faster than a 50K one — and explicitly rejected the 80K/140K an earlier pass proposed
 * as extrapolated from a four-generation-stale model. There is no published accuracy-vs-length curve
 * for any Claude 5 model (ticket 15), so the real numbers can only be measured; ticket 16 is that
 * measurement and it has not reported yet. The one relative fact worth encoding is that the smaller
 * models degrade about twice as early (~32K vs ~64K effective), which is where the halved row comes
 * from.
 */
const MODEL_BUDGETS: readonly { match: RegExp; budget: Budget }[] = [
  { match: /^claude-(?:opus|fable|mythos)-/, budget: { soft: 180_000, hard: 300_000 } },
  { match: /^claude-(?:sonnet|haiku)-/, budget: { soft: 90_000, hard: 150_000 } },
];

/** What an unrecognised model gets: the conservative row, because guessing high nudges too late. */
const DEFAULT_BUDGET: Budget = { soft: 90_000, hard: 150_000 };

/**
 * Codex sees far less telemetry and its own CLI compacts rather than rotates, so the numbers are
 * proportions of its window rather than a claim about `gpt-5.6-sol` specifically.
 */
const CODEX_BUDGET: Budget = { soft: 150_000, hard: 220_000 };

/**
 * A budget can never usefully exceed the physical window: past the window is the WALL, which is not
 * a budget question at all. These caps only ever bind on a small-window model — an Opus session's
 * budget is a fraction of its million — and they exist so a table row that is generous for one
 * family cannot silently push a 200K model's soft threshold past the point of no return.
 */
const SOFT_CAP = 0.55;
const HARD_CAP = 0.9;

export function budgetFor(args: {
  engine: EEngine;
  model: string;
  /** The window the engine REPORTED, when it reported one. Beats anything resolved from the name. */
  contextLimit?: number | undefined;
}): Budget {
  const codex = args.engine === EEngine.codex;
  const limit =
    args.contextLimit ?? (codex ? CODEX_FALLBACK_LIMIT : resolveContextLimit(args.model));
  const base = codex
    ? CODEX_BUDGET
    : (MODEL_BUDGETS.find((row) => row.match.test(args.model))?.budget ?? DEFAULT_BUDGET);
  return {
    soft: Math.min(base.soft, Math.round(limit * SOFT_CAP)),
    hard: Math.min(base.hard, Math.round(limit * HARD_CAP)),
  };
}
