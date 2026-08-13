/**
 * The master job list, grouped or not.
 *
 * One page serves both shapes, because they are the same list seen from two distances: launched
 * inside a repository you get that project's jobs flat, launched anywhere else you get every job
 * with a project header above each run. The header does not appear and disappear with the row
 * count — it is the SCOPE that decides, so the list never reorganises itself under you as jobs come
 * and go.
 *
 * Headers are furniture. The cursor walks jobs only, which is why each job entry carries the index
 * it will hold once drawn: making a header selectable would put dead stops in the middle of a list
 * whose entire purpose is to be arrowed through.
 *
 * There are two axes and the scope picks exactly one: unscoped spends headers on projects, scoped
 * spends them on worktrees (`groupJobsByWorktree`). Both emit this same entry union so the page has
 * one list, one cursor and one index rule regardless of which axis it asked for.
 */

import type { WorktreeGroup } from './worktree.js';

export enum EJobEntry {
  header = 'header',
  /** A worktree of the scoped project. Furniture, exactly like a project header. */
  worktree = 'worktree',
  job = 'job',
}

export type JobEntry<T> =
  | { kind: EJobEntry.header; projectId: string; projectName: string }
  | {
      kind: EJobEntry.worktree;
      group: WorktreeGroup;
      /**
       * A cursor stop, or null for furniture.
       *
       * Only an EMPTY worktree gets one, and the exception proves the rule rather than breaking it:
       * the reason headers are unselectable is that a stop between two rows is a dead stop in a list
       * you arrow through, and a heading with nothing under it has no rows to sit between. It is not
       * a header at that point — it is the whole entry.
       */
      index: number | null;
    }
  | { kind: EJobEntry.job; job: T; index: number };

/**
 * The entries the cursor can land on, in draw order.
 *
 * The single source of the page's `total`, and of what `highlighted` IS — deriving both from one
 * filtered list is what keeps a stop's position and the `index` stamped on it from ever disagreeing.
 */
export function selectableEntries<T>(
  entries: readonly JobEntry<T>[],
): JobEntry<T>[] {
  return entries.filter(
    (entry) =>
      entry.kind === EJobEntry.job ||
      (entry.kind === EJobEntry.worktree && entry.index !== null),
  );
}

/** Structural, so `domain/` never learns what a repository row looks like. */
export type GroupableJob = {
  projectId: string;
  projectName: string;
};

/**
 * Jobs arrive sorted by recency across ALL projects, so a project's jobs are interleaved with
 * everyone else's. Grouping therefore has to GATHER rather than chunk runs of equal neighbours —
 * chunking would emit the same header twice for a project you touched either side of another.
 *
 * Project order is first appearance, which given a recency-sorted input means most-recently-touched
 * first. Sorting the groups alphabetically instead would bury the project you were in ten seconds
 * ago somewhere in the middle of the screen.
 */
export function groupJobs<T extends GroupableJob>(args: {
  jobs: readonly T[];
  grouped: boolean;
}): JobEntry<T>[] {
  if (!args.grouped) {
    return args.jobs.map((job, index) => ({ kind: EJobEntry.job, job, index }));
  }

  const order: string[] = [];
  const byProject = new Map<string, T[]>();
  for (const job of args.jobs) {
    const existing = byProject.get(job.projectId);
    if (existing) {
      existing.push(job);
      continue;
    }
    order.push(job.projectId);
    byProject.set(job.projectId, [job]);
  }

  const entries: JobEntry<T>[] = [];
  // Counted as rows are emitted rather than taken from the input position: `index` has to match
  // where the row is DRAWN, or one press of ↓ lands somewhere the eye did not go.
  let index = 0;
  for (const projectId of order) {
    const jobs = byProject.get(projectId) ?? [];
    const first = jobs[0];
    if (!first) continue;
    entries.push({
      kind: EJobEntry.header,
      projectId,
      projectName: first.projectName,
    });
    for (const job of jobs) {
      entries.push({ kind: EJobEntry.job, job, index });
      index += 1;
    }
  }
  return entries;
}

/**
 * Jobs another terminal is driving sink to the bottom, keeping their order among themselves.
 *
 * Sorted rather than hidden, and still selectable: a claim is information, not a permission. And
 * sorted rather than merely dimmed, because in a six-tile grid the rows you can act on should be
 * the rows your eye lands on first — dimming alone still makes you read past them.
 *
 * Applied BEFORE grouping, so a project's claimed jobs fall to the end of that project's run rather
 * than to the end of the screen, where they would be separated from the header naming them.
 */
export function sortClaimedLast<T>(args: {
  jobs: readonly T[];
  isClaimed: (job: T) => boolean;
}): T[] {
  const open: T[] = [];
  const claimed: T[] = [];
  for (const job of args.jobs) (args.isClaimed(job) ? claimed : open).push(job);
  return [...open, ...claimed];
}
