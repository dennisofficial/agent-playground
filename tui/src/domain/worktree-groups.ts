import { resolve } from 'node:path';
import { EJobEntry, type JobEntry } from './job-groups.js';
import { EWorkspaceKind, type WorktreeGroup } from './worktree.js';
import type { GitWorktree } from './worktree-list.js';

/**
 * The scoped job list, grouped by the worktree its jobs are standing in.
 *
 * A project IS a git repository — that is what `mainWorktreeFromCommonDir` decides, by resolving a
 * linked worktree back to the main one rather than minting a second `Project` row. So every worktree
 * of the repo is already inside the project, and this is only making that visible: the same code, on
 * different branches, with the jobs distributed across them.
 *
 * A worktree with jobs under it is a HEADER — furniture, unselectable, for the reason
 * `job-groups.ts` gives about project headers: a stop between two rows is a dead stop in a list whose
 * whole purpose is to be arrowed through.
 *
 * A worktree with NO jobs is a stop. It has no rows to sit between, so the objection does not apply,
 * and it is the only entry on the page you can act on that is not a job: `⏎` starts a job in it, `x`
 * removes it. Everything that follows about `index` exists to keep those two kinds walking under one
 * cursor without either learning about the other.
 */

/** Structural, so `domain/` never learns what a job row looks like. */
export type WorktreeGroupableJob = { workspacePath: string | null };

export function groupJobsByWorktree<T extends WorktreeGroupableJob>(args: {
  jobs: readonly T[];
  worktrees: readonly GitWorktree[];
  /** The project path, which is the main worktree by construction. */
  projectPath: string;
  /**
   * Whether to emit worktrees with nothing under them — the pinned main one, and the leaks.
   *
   * False while a filter is running, and that is not a detail. `groupJobs` never emits a project
   * header for a project with no matching jobs, so filtering there quietly narrows the list; a
   * worktree axis that kept every heading would instead SPROUT furniture as you typed, until a query
   * matching nothing left a screen of headings and no rows. A filter is a search, not a scope.
   */
  includeEmpty: boolean;
}): JobEntry<T>[] {
  // No worktrees means git had nothing to say — the folder is not a repository, or the read failed.
  // Either way a single heading over every row would be a claim this function cannot support, so the
  // list falls back to exactly what it was before.
  if (args.worktrees.length === 0) {
    return args.jobs.map((job, index) => ({ kind: EJobEntry.job, job, index }));
  }

  const main = pathKey(args.projectPath);
  const listed = new Map<string, GitWorktree>();
  for (const worktree of args.worktrees) listed.set(pathKey(worktree.path), worktree);

  // The main worktree is pinned first and emitted even when empty. It names the branch your editor
  // is on and the branch a job with no worktree of its own will commit to — the one fact
  // `workspaceState` exists to keep loud — so it is furniture that is always there, not a group that
  // appears once something lands in it.
  const order: string[] = [main];
  const byPath = new Map<string, T[]>([[main, []]]);
  const empties = new Set<string>([main]);

  // Jobs arrive recency-sorted, so first appearance means most-recently-touched worktree first —
  // the same ordering rule the project grouping uses, for the same reason.
  for (const job of args.jobs) {
    const key = job.workspacePath === null ? main : pathKey(job.workspacePath);
    empties.delete(key);
    const bucket = byPath.get(key);
    if (bucket) {
      bucket.push(job);
      continue;
    }
    order.push(key);
    byPath.set(key, [job]);
  }

  // Worktrees no job is working in, last. These are the leak: a job deleted out from under its
  // worktree, a branch someone checked out by hand, a native tool that relocated work without
  // telling Atlas. Nothing else in the app can currently see them.
  for (const key of listed.keys()) {
    if (byPath.has(key)) continue;
    order.push(key);
    byPath.set(key, []);
    empties.add(key);
  }

  const entries: JobEntry<T>[] = [];
  // Counted as stops are emitted, never taken from the input position — `index` has to match where
  // the stop is DRAWN or one press of ↓ lands somewhere the eye did not go. ONE counter across both
  // kinds, because the cursor does not know it is walking two of them.
  let index = 0;
  for (const key of order) {
    const empty = empties.has(key);
    if (empty && !args.includeEmpty) continue;
    const jobs = byPath.get(key) ?? [];
    const group = groupFor({
      path: key,
      worktree: listed.get(key),
      here: key === main,
      jobs: jobs.length,
    });
    // The main worktree is furniture even when empty. It is not a leak and there is nothing to
    // release, so a stop on it would be a stop that no key does anything with — `⏎` cannot mean
    // "start a job here" on the heading that already describes where `+ new job` puts one.
    const stop = empty && !group.here;
    entries.push({ kind: EJobEntry.worktree, group, index: stop ? index : null });
    if (stop) index += 1;
    for (const job of jobs) {
      entries.push({ kind: EJobEntry.job, job, index });
      index += 1;
    }
  }
  return entries;
}

/**
 * `resolve` only — never `realpath`.
 *
 * `domain/` touches no filesystem, and the paths being matched come from two places that agree by
 * construction: git prints what `worktree add` was given, and `worktreePathFor` joins onto the same
 * project path. Resolving symlinks would be more correct in the abstract and would cost this module
 * its testability, to fix a case that cannot arise from Atlas's own writes.
 */
function pathKey(path: string): string {
  return resolve(path).replace(/[\\/]+$/, '');
}

function groupFor(args: {
  path: string;
  worktree: GitWorktree | undefined;
  here: boolean;
  jobs: number;
}): WorktreeGroup {
  const { worktree } = args;
  const base = {
    path: args.path,
    jobCount: args.jobs,
    branch: worktree?.branch ?? null,
  };

  // Recorded by a job but absent from `git worktree list`, or present with its gitdir pointing at
  // nothing. Both mean the directory is gone, and NEITHER is folded into the main group —
  // `workspaceState` refuses the same downgrade for the same reason: the worktree existed to keep an
  // agent out of the tree that fallback would put it back into.
  if (!worktree || worktree.prunable) {
    return {
      ...base,
      kind: EWorkspaceKind.missing,
      glyph: '⚠',
      here: false,
      label: `worktree missing: ${args.path}`,
    };
  }

  const label = branchLabel(worktree);
  if (args.here) {
    // `· here` rather than `· in place`: the job page says where one job stands, and this says which
    // of several trees you are looking at from. Same glyph, because it is the same tree.
    return {
      ...base,
      kind: EWorkspaceKind.inPlace,
      glyph: '⌂',
      here: true,
      label: `${label} · here`,
    };
  }
  return { ...base, kind: EWorkspaceKind.worktree, glyph: '⑂', here: false, label };
}

/** What to call a worktree: its branch, or the honest alternative when it has none. */
function branchLabel(worktree: GitWorktree): string {
  const suffix = worktree.locked ? ' · locked' : '';
  if (worktree.branch) return `${worktree.branch}${suffix}`;
  // A bare repository has no working tree at all, so it is named before the detached case — every
  // bare worktree is also detached, and "bare" is the more useful of the two answers.
  if (worktree.bare) return `bare repository${suffix}`;
  if (worktree.head) return `detached at ${worktree.head.slice(0, 7)}${suffix}`;
  return `detached${suffix}`;
}
