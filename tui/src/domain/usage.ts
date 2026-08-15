import { EEngine } from '../generated/prisma/enums.js';
import type { UsageWindowKey } from './message.js';

/** `null` is a REAL state, not zero: usage is unknown until a poll or a turn reports one. */
export type UsageWindow = { utilization: number; resetsAt: string | null } | null;

/**
 * `spent` is not "very red", it is a different kind of fact: a window at 100% has no quantity left
 * to report, so the bar and the percent stop being answers and the countdown becomes the only one.
 */
export type MeterBand = 'unknown' | 'normal' | 'warn' | 'hot' | 'red' | 'spent';

/**
 * The windows whose band falls out of their own fill. `ctx` is deliberately NOT one of them: it is
 * full of tokens the model can still use, and what makes those tokens worth reacting to is the
 * rotation budget, not how much of the window is left. It supplies its own band — see `Meter.band`
 * and `pressureBand`.
 */
export type MeterKey = 'fiveHour' | 'sevenDay' | 'extraUsage';

/**
 * Thresholds differ per window because the windows mean different things — `wk` earns attention
 * latest because a two-thirds-spent week is simply Thursday.
 *
 * `extraUsage` is the odd one: it is not a window that refills, it is a monthly SPEND limit, and the
 * quantity behind it is money. So it warns earliest of the three — the point at which a human might
 * still choose to stop is well before the point at which the server does it for them.
 */
const BANDS: Record<MeterKey, { warn: number; hot: number; red: number }> = {
  fiveHour: { warn: 65, hot: 82, red: 93 },
  sevenDay: { warn: 70, hot: 86, red: 95 },
  extraUsage: { warn: 50, hot: 75, red: 90 },
};

/**
 * What the server says about an account's credits, as distinct from what Atlas is ALLOWED to do with
 * them (`Account.extraUsageAllowed`). `enabled: false` means the subscription has no credits
 * provisioned at all — no toggle in Atlas can conjure them; that is a trip to `/usage-credits`.
 */
export type ExtraUsage = {
  enabled: boolean;
  /** Percentage of the monthly credit limit spent. `null` when the plan reports no limit. */
  utilization: number | null;
} | null;

export function meterBand(key: MeterKey, utilization: number | null): MeterBand {
  if (utilization === null) return 'unknown';
  // `spent` is for windows that REFILL: at 100% they have nothing left to report and the countdown
  // becomes the only answer.
  if (utilization >= 100) return 'spent';
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
 *
 * Rounds UP, because a five-cell bar quantises 20% at a time and the two directions are not equally
 * wrong on a pressure gauge: rounding down draws headroom that is not there, and the whole point of
 * the meter is to be glanced at rather than read. Overstating costs a cell of alarm; understating
 * costs the glance that would have caught a window filling. The digits beside it carry the precision.
 *
 * A non-zero window therefore always fills at least one cell — "barely started" and "unknown" must
 * not draw identically, and rounding up gets that for free rather than needing a floor.
 */
export function meterFill(utilization: number | null, cells: number): number {
  if (utilization === null || utilization <= 0) return 0;
  return Math.min(cells, Math.ceil((utilization / 100) * cells));
}

/**
 * One gauge, ready to draw. The band is passed IN rather than derived here because the two kinds of
 * meter answer it differently: an account window is coloured by its own fill, and `ctx` is coloured
 * by budget pressure while its bar draws window occupancy.
 */
export type Meter = {
  label: string;
  band: MeterBand;
  window: UsageWindow;
  /** Printed instead of the percentage. `ctx` reads in tokens — see `formatTokens`. */
  digits?: string;
};

/** Normalise the SDK's 0..1-or-0..100 utilisation into a percent. */
export function toPercent(utilization: number | undefined): number | null {
  if (utilization == null) return null;
  const percent = utilization <= 1 ? utilization * 100 : utilization;
  return Math.round(Math.min(100, Math.max(0, percent)));
}

/**
 * The `ctx` meter's number: occupancy of the PHYSICAL window, so `82%` means 82% of the context the
 * model actually has. Clamped, because there is nothing past the window — that is the wall.
 *
 * It deliberately does not read against the rotation budget. The budget is a cost argument and it
 * still drives every nudge (in tokens, see `decideNudge`), but a meter that reported `127%` was
 * answering a question nobody asks of a gauge: what is left is what the number should say.
 */
export function windowPercent(args: { tokens: number; limit: number }): number {
  if (args.limit <= 0) return 0;
  return Math.round(Math.min(100, Math.max(0, (args.tokens / args.limit) * 100)));
}

export function windowKeyFor(rateLimitType: string | undefined): UsageWindowKey | null {
  switch (rateLimitType) {
    case 'five_hour':
      return 'fiveHour';
    case 'seven_day':
    case 'seven_day_opus':
    case 'seven_day_sonnet':
    // The weekly window as the server draws it for a credits-enabled account. Still the weekly
    // window: folding it onto `wk` is the same choice `nearestWall` already makes for the variants.
    case 'seven_day_overage_included':
      return 'sevenDay';
    // NOT a window. `overage` is the credit balance, and mapping it to `fiveHour` — which is what
    // the `?? 'fiveHour'` fallback below used to do for it — reported a spent WALLET as a spent
    // five-hour window and sent rotation looking for headroom that was never the problem.
    case 'overage':
      return null;
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
 * measurement and it has not reported yet.
 *
 * **The Opus row is deliberately ABOVE design 06's seed — 300K/420K, being tried in anger.** The doc
 * reasoned from cost alone, and against a million-token window 180K asked for a hand-off at 18%
 * occupancy: often several times a working session, and often while the agent was still sharp. Since
 * the soft tier now advises rather than orders (`handoffAdvisory`), the cost of nudging LATE is one
 * more expensive turn, while the cost of nudging early is a seam the work did not need. That trade
 * moved, so the threshold moved with it. Revert here if quality falls off before 300K in practice —
 * this is the number ticket 16 is meant to replace, not a second theory to defend.
 *
 * The gap to `hard` is held at 120K rather than scaled with `soft`: it is the runway the agent gets
 * to pick its own seam, and at the +30K/+20K cadence 120K is already ~6 escalating asks. Widening it
 * would only delay the escalation, not learn anything more from it.
 */
const MODEL_BUDGETS: readonly { match: RegExp; budget: Budget }[] = [
  { match: /^claude-(?:opus|fable|mythos)-/, budget: { soft: 300_000, hard: 420_000 } },
  // NOT "half the Opus row" any more, and that relation is not worth restoring by arithmetic: this
  // row stands on its own claim — the smaller models degrade about twice as early (~32K vs ~64K
  // effective), which is the one relative fact the research supports. The Opus bump above is a trial
  // of a cost trade-off; nothing about it says these models hold their quality any longer.
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
