import type { EPhaseKind, EThreadRole } from '../generated/prisma/enums.js';
import {
  attentionFor,
  EAttentionScope,
  unionFacts,
  type Attention,
  type AttentionFacts,
} from './attention.js';
import { affords, elasticColumn } from './list-columns.js';
import { hasUnseen } from './read-state.js';
import { roleLabel } from './role-engine.js';

/** `  ▸ ` + `● `, and the timestamp at the end — the two columns that are never negotiable. */
export const GUTTER = 6;
const WHEN = 5;
const MARGIN = 2;
/**
 * `⠹ start a phase` wants fifteen columns. The old twenty held `build · builder`, which left the
 * row when the column became the verb you owe rather than where the job happens to be standing.
 */
const STATUS_FORMS = [14, 11, 0];
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
 * `build · builder` — where the job is standing. This no longer draws: the status column says what
 * you OWE, and a job is not its cursor. It survives as filter text, because the phase and the role
 * remain the most natural thing to type when you are looking for a job by what it was doing.
 */
export function jobSummary(job: JobSummarySource): string {
  if (!job.activePhase || !job.activeRole) return 'active';
  return `${job.activePhase} · ${roleLabel(job.activeRole)}`;
}

/** One thread of a job, as far as the job's condition is concerned. */
export type JobThreadSource = {
  id: string;
  closed: boolean;
  lastMessageAt: Date | null;
  lastSeenAt: Date | null;
};

/**
 * A job's condition is the SAME function a thread row runs, over the union of its threads' facts.
 * No priority table: the ordering inside the verb already says a keypress you owe beats a
 * conversation you owe, and a second table one level up would only be a copy to keep in sync.
 *
 * `hasPullRequest` is false everywhere until ticket 18 gives `Job.prNumber` a writer — at which
 * point `shipped` starts occurring with no change here. The absence of a fact is the absence of a
 * state, which is the entire point of deriving it.
 */
export function jobAttention(args: {
  threads: readonly JobThreadSource[];
  runningThreadIds: readonly string[];
  proposalThreadIds?: readonly string[];
  hasPullRequest?: boolean;
}): Attention {
  const facts = args.threads.map<AttentionFacts>((thread) => ({
    turnRunning: args.runningThreadIds.includes(thread.id),
    proposalPending: args.proposalThreadIds?.includes(thread.id) ?? false,
    openThreadCount: thread.closed ? 0 : 1,
    unseen: hasUnseen({ lastMessageAt: thread.lastMessageAt, lastSeenAt: thread.lastSeenAt }),
    hasPullRequest: args.hasPullRequest ?? false,
  }));
  return attentionFor({
    facts: { ...unionFacts(facts), hasPullRequest: args.hasPullRequest ?? false },
    scope: EAttentionScope.job,
  });
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
