import type { EPhaseKind, EThreadRole } from '../generated/prisma/enums.js';
import { affords, elasticColumn } from './list-columns.js';
import { roleLabel } from './role-engine.js';

/** `  ▸ ` + `⏺ `, and the timestamp at the end — the two columns that are never negotiable. */
export const GUTTER = 6;
const WHEN = 5;
const MARGIN = 2;
/** `build · builder` wants twenty columns; `active` and `working…` fit in ten. */
const STATUS_FORMS = [20, 10, 0];
const TITLE = { min: 16, max: 56 };

export type JobsLayout = { title: number; status: number };

/**
 * Longest-first: the widest status form that still leaves the title its minimum wins. Dropping the
 * status entirely is the last resort, because a job row without a title identifies nothing.
 */
export function jobsLayout(width: number): JobsLayout {
  for (const status of STATUS_FORMS) {
    const fixed = GUTTER + status + WHEN + MARGIN;
    if (affords(width, fixed, TITLE.min))
      return { title: elasticColumn(width, fixed, TITLE), status };
  }
  return { title: Math.max(3, width - GUTTER - WHEN - MARGIN), status: 0 };
}

/** The facts a row draws — structural so `domain/` stays clear of the repositories. */
export type JobSummarySource = {
  activePhase: EPhaseKind | null;
  activeRole: EThreadRole | null;
};

/**
 * `build · builder`, or where the job stands when no thread is active. There is no stored status to
 * outrank the pointer — a job's condition is derived from facts, and the only facts this row has
 * today are the phase and role it is pointing at.
 */
export function jobSummary(job: JobSummarySource): string {
  if (!job.activePhase || !job.activeRole) return 'active';
  return `${job.activePhase} · ${roleLabel(job.activeRole)}`;
}

/** There is no archive state and no undo, so the confirm quotes the transcript it is about to burn. */
export function deletionCost(job: { messageCount: number }): string {
  const messages =
    job.messageCount === 0
      ? 'nothing said yet'
      : `${job.messageCount} message${job.messageCount === 1 ? '' : 's'}`;
  return `${messages} · every thread, session and the job’s /context folder go with it`;
}

/**
 * Today shows a clock, this week a weekday, older a date — the same shape the wireframes use.
 *
 * `now` is a parameter rather than a `Date.now()` read so the boundaries are testable; every caller
 * wants the default.
 */
export function formatWhen(args: { date: Date; now?: Date }): string {
  const { date } = args;
  const now = args.now ?? new Date();
  if (date.toDateString() === now.toDateString()) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  const days = (now.getTime() - date.getTime()) / 86_400_000;
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
