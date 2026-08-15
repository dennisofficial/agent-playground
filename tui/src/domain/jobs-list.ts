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
import { isAtlasBranch } from './worktree.js';

/** `  ▸ ` + `● `, and the timestamp at the end — the two columns that are never negotiable. */
export const GUTTER = 6;
const WHEN = 5;
const MARGIN = 2;
/**
 * `⠹ start a phase` wants fifteen columns. The old twenty held `build · builder`, which left the
 * row when the column became the verb you owe rather than where the job happens to be standing.
 *
 * Two columns wider than the verbs alone need, because the status cell also carries `SERVICE_MARK`
 * for a job holding a live process. Reserved in the LAYOUT rather than taken out of the margin at
 * draw time: the mark is the only thing telling a scanning eye that a dev server is up, and a form
 * that fits the verb but truncates the mark hides exactly the row that is holding something.
 */
const STATUS_FORMS = [16, 13, 0];
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

/**
 * Pending proposals as the rows want them: which threads are waiting, under the job that is waiting.
 *
 * The list reads them unscoped in one query — a pending row exists only between an agent asking and
 * Dennis answering, so there are never many — and this is the whole of the shaping. Keyed by job and
 * carrying THREADS, because a job's condition is the union of its threads' facts and `jobAttention`
 * is the only place that ordering lives.
 */
export function proposalsByJob(
  proposals: readonly { jobId: string; raisedByThreadId: string }[],
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const proposal of proposals) {
    grouped.set(proposal.jobId, [
      ...(grouped.get(proposal.jobId) ?? []),
      proposal.raisedByThreadId,
    ]);
  }
  return grouped;
}

/**
 * There is no archive state and no undo, so the confirm quotes the transcript it is about to burn.
 *
 * It also names what happens to the WORKTREE, because that is the half of the cost the job's own row
 * never mentions and the half that can reach work Atlas did not create. The three outcomes are
 * genuinely different and the sentence has to say which one you are buying — a confirm that reads the
 * same whether or not your hand-made tree survives is a confirm that lies once.
 */
export function deletionCost(job: {
  messageCount: number;
  branch: string | null;
  workspacePath: string | null;
}): string {
  const messages =
    job.messageCount === 0
      ? 'nothing said yet'
      : `${job.messageCount} message${job.messageCount === 1 ? '' : 's'}`;
  const base = `${messages} · every thread, session and the job’s /context folder go with it`;
  if (job.workspacePath === null) return base;
  if (!isAtlasBranch(job.branch)) {
    // Adopted. `release()` clears the field and leaves the directory, so the promise is keepable.
    return `${base} · ${job.branch ?? 'the branch'} is not Atlas’s, so its worktree stays`;
  }
  // The branch outliving its directory is not a detail: it may already carry a pull request.
  return `${base} · the worktree goes, ${job.branch ?? 'its branch'} survives`;
}

/**
 * What `x` costs on a worktree nothing is working in.
 *
 * Deliberately quiet about the branch surviving being a *consolation* — for an `atlas/` worktree the
 * branch is very possibly the only copy of a deleted job's work, which is exactly why
 * `removeWorktree` never touches it.
 */
export function releaseCost(group: { label: string; path: string }): string {
  return `the directory goes, ${group.label} survives · ${group.path}`;
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
