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
 * earliest because you can act on it this second (rotate, compact), and `wk` latest because a
 * two-thirds-spent week is simply Thursday.
 */
const BANDS: Record<MeterKey, { warn: number; hot: number; red: number }> = {
  ctx: { warn: 60, hot: 78, red: 90 },
  fiveHour: { warn: 65, hot: 82, red: 93 },
  sevenDay: { warn: 70, hot: 86, red: 95 },
};

export function meterBand(key: MeterKey, utilization: number | null): MeterBand {
  if (utilization === null) return 'unknown';
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
