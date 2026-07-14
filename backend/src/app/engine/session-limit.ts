/**
 * Detection of a Claude subscription SESSION/USAGE limit hit, from the two signals the CLI surfaces: the
 * structured `rate_limit_event` frame (primary) and — as a fallback for CLI drift or older frames — the
 * printed limit line in assistant text or a thrown error message. Pure and zero-dependency (mirrors
 * `claude-auth.ts`): imports no SDK types, so it stays usable on both sides of the wire and in unit tests.
 */

import type { SessionLimitHit } from '@workspace/agent-engine';

/** A detected subscription limit hit — moved to `@workspace/agent-engine`; re-exported here for existing
 *  import sites. */
export type { SessionLimitHit } from '@workspace/agent-engine';

/**
 * Normalize the SDK's `rate_limit_event.resetsAt` epoch to an ISO string. The SDK reports it in epoch
 * SECONDS (a 10-digit value like 1783650000), NOT milliseconds — so a bare `new Date(resetsAt)` lands in
 * 1970. Guard both units: anything below 1e12 is treated as seconds and scaled to ms; a value already in ms
 * passes through. Returns undefined for missing/NaN input.
 */
export function resetEpochToIso(resetsAt: number | undefined | null): string | undefined {
  if (resetsAt == null) return undefined;
  const ms = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * PRIMARY structured signal. Reads the `SDKRateLimitInfo` shape (kept structural/loose so this util imports
 * no SDK types). `status: 'rejected'` is a HARD limit → return a hit (`resetAt` derived from the epoch
 * `resetsAt`, see {@link resetEpochToIso}). Any other status (`allowed` / `allowed_warning`) is not a wall.
 */
export function limitFromRateEvent(info: {
  status: string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
}): SessionLimitHit | null {
  if (info.status !== 'rejected') return null;
  return {
    resetAt: resetEpochToIso(info.resetsAt),
    rateLimitType: info.rateLimitType,
    utilization: info.utilization,
  };
}

/** Matches the printed subscription-limit line the CLI emits (or a thrown error carrying the same text). */
const SESSION_LIMIT_RE =
  /\b(?:hit your (?:usage|session) limit|usage limit reached|session limit reached)\b/i;

/** FALLBACK for CLI drift / older frames: does this assistant text or error message announce a limit hit? */
export function detectSessionLimitText(text: string | null | undefined): boolean {
  return typeof text === 'string' && SESSION_LIMIT_RE.test(text);
}

/**
 * The shortest Claude subscription window (5 hours), in ms. Used as a BOUNDED default resume clock when a
 * limit is detected but no precise reset instant is known: parking on a null clock would never auto-resume
 * (the leader sweep only fires on a non-null `session_resume_at <= now()`), so a limit could then only ever
 * be Force-resumed by hand.
 */
export const SESSION_LIMIT_DEFAULT_RESUME_MS = 5 * 60 * 60 * 1000;

/** A bounded fallback reset instant (now + shortest subscription window) so a durable resume clock is always set. */
export function defaultResumeAt(now: Date = new Date()): string {
  return new Date(now.getTime() + SESSION_LIMIT_DEFAULT_RESUME_MS).toISOString();
}

/** A clock time like "5:20pm", "5pm", "11:30am" — optional minutes, required am/pm marker. */
const CLOCK_RE = /(\d{1,2})(?::(\d{2}))?\s*([ap])m\b/i;

/** Convert a 12-hour clock (1-12 + am/pm) to its 0-23 hour, or null when out of range. */
function to24Hour(hour12: number, meridiem: 'a' | 'p'): number | null {
  if (hour12 < 1 || hour12 > 12) return null;
  const noon = meridiem === 'p';
  if (hour12 === 12) return noon ? 12 : 0;
  return noon ? hour12 + 12 : hour12;
}

/**
 * LAST RESORT: parse a printed "resets 5:20pm (UTC)" / "resets 5pm" style string into a best-effort ISO of
 * the NEXT occurrence of that clock time. Any trailing timezone-ish text is ignored (the time is treated as
 * local). Returns undefined when no clock time is present. `now` is injectable for deterministic tests.
 */
export function parseResetAt(text: string, now: Date = new Date()): string | undefined {
  const match = CLOCK_RE.exec(text);
  if (!match) return undefined;
  const minutes = match[2] ? Number(match[2]) : 0;
  if (minutes > 59) return undefined;
  const hour = to24Hour(Number(match[1]), match[3].toLowerCase() as 'a' | 'p');
  if (hour === null) return undefined;

  const reset = new Date(now);
  reset.setHours(hour, minutes, 0, 0);
  if (reset.getTime() <= now.getTime()) reset.setDate(reset.getDate() + 1);
  return reset.toISOString();
}
