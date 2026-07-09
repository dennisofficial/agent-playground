/**
 * Detection of a Claude subscription SESSION/USAGE limit hit, from the two signals the CLI surfaces: the
 * structured `rate_limit_event` frame (primary) and — as a fallback for CLI drift or older frames — the
 * printed limit line in assistant text or a thrown error message. Pure and zero-dependency (mirrors
 * `claude-auth.ts`): imports no SDK types, so it stays usable on both sides of the wire and in unit tests.
 */

/** A detected subscription limit hit — the resume metadata the host parks the lane on. */
export type SessionLimitHit = {
  /** ISO-8601 instant the limit window resets, when known (best-effort). */
  resetAt?: string;
  /** The SDK's window bucket (e.g. `five_hour`, `seven_day_opus`), when the structured frame carried one. */
  rateLimitType?: string;
  /** 0-100 window utilization at the time of the hit, when reported. */
  utilization?: number;
};

/**
 * PRIMARY structured signal. Reads the `SDKRateLimitInfo` shape (kept structural/loose so this util imports
 * no SDK types). `status: 'rejected'` is a HARD limit → return a hit (`resetAt` derived from the epoch-ms
 * `resetsAt`). Any other status (`allowed` / `allowed_warning`) is not a wall → return null.
 */
export function limitFromRateEvent(info: {
  status: string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
}): SessionLimitHit | null {
  if (info.status !== 'rejected') return null;
  return {
    resetAt: info.resetsAt ? new Date(info.resetsAt).toISOString() : undefined,
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
