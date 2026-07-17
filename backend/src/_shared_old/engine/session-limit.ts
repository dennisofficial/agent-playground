
import type { SessionLimitHit } from '@workspace/agent-engine';

export type { SessionLimitHit } from '@workspace/agent-engine';

export function resetEpochToIso(resetsAt: number | undefined | null): string | undefined {
  if (resetsAt == null) return undefined;
  const ms = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

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
    source: 'structured',
  };
}

const SESSION_LIMIT_RE =
  /\b(?:hit your (?:usage|session) limit|usage limit reached|session limit reached)\b/i;

export function detectSessionLimitText(text: string | null | undefined): boolean {
  return typeof text === 'string' && SESSION_LIMIT_RE.test(text);
}

export const SESSION_LIMIT_DEFAULT_RESUME_MS = 5 * 60 * 60 * 1000;

export function defaultResumeAt(now: Date = new Date()): string {
  return new Date(now.getTime() + SESSION_LIMIT_DEFAULT_RESUME_MS).toISOString();
}

const CLOCK_RE = /(\d{1,2})(?::(\d{2}))?\s*([ap])m\b/i;

function to24Hour(hour12: number, meridiem: 'a' | 'p'): number | null {
  if (hour12 < 1 || hour12 > 12) return null;
  const noon = meridiem === 'p';
  if (hour12 === 12) return noon ? 12 : 0;
  return noon ? hour12 + 12 : hour12;
}

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

export function textSessionLimitHit(text: string): SessionLimitHit {
  return { source: 'text', resetAt: parseResetAt(text) };
}

export const SESSION_LIMIT_CORROBORATE_MIN_UTIL = 95;
export const SESSION_LIMIT_TEXT_MISFIRE_MAX = 3;

export function isCorroboratedSessionLimit(
  source: 'structured' | 'text' | undefined,
  windowUtilization: number | undefined,
): boolean {
  if (source !== 'text') return true; // structured (or legacy/undefined) = genuine wall
  return windowUtilization != null && windowUtilization >= SESSION_LIMIT_CORROBORATE_MIN_UTIL;
}
