import { basename, dirname, join } from 'node:path';

/**
 * A job may take its own branch and its own worktree. The argument is NOT concurrency — one branch
 * at a time is the norm here — it is that the editor is open on the project path, and checking a
 * branch out there yanks it onto the agent's branch mid-thought. A worktree means Atlas never
 * touches the tree you are looking at.
 *
 * Pure naming and path rules only: everything in this file must be decidable without a git
 * repository, so the shape of a worktree can be tested without creating one.
 */

/** Every worktree for a project lives here, inside the repo but outside the tracked tree. */
export const WORKTREES_DIR = '.worktrees';

/** `atlas/…` — so `git branch` says who made it, and a stray branch is identifiable months later. */
const BRANCH_PREFIX = 'atlas/';

/** Enough of the id to separate two jobs; the readable part of the name is the title. */
const ID_CHARS = 8;
/** Directory and ref names stay legible in `git worktree list` and a shell prompt. */
const NAME_MAX = 48;

/**
 * The MAIN worktree, from `git rev-parse --path-format=absolute --git-common-dir`.
 *
 * The common dir is shared by every linked worktree, so this answers "which repository am I in"
 * identically from `/repo` and from `/repo/.worktrees/foo`. Without it, opening Atlas inside a
 * worktree would mint a SECOND project row (`Project.path` is `@unique`) with its own job list.
 *
 * Null means the folder is not a repository at all — the caller keeps the path it was given.
 */
export function mainWorktreeFromCommonDir(commonDir: string): string | null {
  const trimmed = commonDir.trim().replace(/[\\/]+$/, '');
  if (trimmed.length === 0) return null;
  // A bare repository's common dir IS its root (`/srv/atlas.git`), with no `.git` segment to strip.
  return basename(trimmed) === '.git' ? dirname(trimmed) : trimmed;
}

/**
 * The directory name for a job's worktree, and the tail of its branch name.
 *
 * Restricted to `[a-z0-9-]` deliberately: git's ref grammar forbids `..`, `~^:?*[`, whitespace and
 * a trailing `.lock`, and a filter this narrow cannot produce any of them — so there is no rule
 * left to enforce separately. The id rides along because two jobs may share a title, and the
 * directory is the job's identity on disk.
 */
export function worktreeNameFor(args: { title: string; jobId: string }): string {
  const short = args.jobId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, ID_CHARS);
  const slug = slugify(args.title).slice(0, NAME_MAX - short.length - 1).replace(/-+$/, '');
  return slug.length === 0 ? `job-${short}` : `${slug}-${short}`;
}

export function branchNameFor(args: { title: string; jobId: string }): string {
  return `${BRANCH_PREFIX}${worktreeNameFor(args)}`;
}

/**
 * Did Atlas make this branch, or did somebody else?
 *
 * This is what `BRANCH_PREFIX` has always been FOR — "so a stray branch is identifiable months
 * later" — now asked as a question. It is the difference between a worktree Atlas may remove and one
 * it may only forget: a job adopted into `dennis/eng-203-…` is standing in a tree that existed before
 * it and must outlive it, and no other fact on the row distinguishes the two.
 *
 * Deliberately a prefix test on the BRANCH rather than on the directory. A worktree can be moved on
 * disk, and `.worktrees/` is only a convention; the branch name is what Atlas actually minted.
 */
export function isAtlasBranch(branch: string | null): boolean {
  return branch !== null && branch.startsWith(BRANCH_PREFIX);
}

export function worktreePathFor(args: {
  projectPath: string;
  title: string;
  jobId: string;
}): string {
  return join(args.projectPath, WORKTREES_DIR, worktreeNameFor(args));
}

/**
 * Where a job's turns run. A job that never took a worktree keeps working in the project path
 * exactly as before — the worktree is optional, and this is the one place that decides.
 */
export function jobCwd(args: { projectPath: string; workspacePath: string | null }): string {
  return args.workspacePath ?? args.projectPath;
}

/**
 * What `enter_worktree` says back, and the one thing it must not leave out: **this turn is still
 * standing in the old tree.**
 *
 * A turn's `cwd` is fixed when the turn starts — the engine is handed a directory and a subprocess
 * is already running in it — so nothing this tool does can relocate the agent that called it. The
 * move lands at the next turn boundary, when `syncCursor` notices `Job.workspacePath` changed and
 * reopens the conversation against the new directory.
 *
 * Saying so is not politeness. An agent told only "you have a worktree at X" will carry straight on
 * editing through relative paths that still resolve into the project tree, and every one of those
 * writes lands in the tree the worktree was taken to stay out of — the original bug, reproduced by
 * the tool built to fix it. Hence the instruction to STOP, stated before the address.
 */
export function worktreeTakenReply(args: {
  branch: string;
  workspacePath: string;
  /** False when the job was already standing here — nothing moved, so nothing is stale. */
  moved: boolean;
}): string {
  const where = `\`${args.workspacePath}\`, on branch \`${args.branch}\``;
  if (!args.moved) {
    return `Already in this worktree: ${where}. Nothing moved, and your working directory is already it — carry on.`;
  }
  return `Worktree taken: ${where}.

**You are not in it yet.** This turn's working directory is still the project tree, and it cannot be changed underneath a running turn — the move takes effect on your next turn, when Atlas reopens this thread against the new directory.

So: **make no further edits this turn.** Finish by saying what you were about to do, and do it next turn, where relative paths will resolve inside the worktree. Anything you write before then lands in the tree this worktree was taken to keep you out of.`;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Where a job's turns run, as the job's own page says it. */
export enum EWorkspaceKind {
  /** The project path — the tree the editor is probably open on. */
  inPlace = 'inPlace',
  worktree = 'worktree',
  /** Recorded a worktree, but it is not on disk any more. */
  missing = 'missing',
}

export type WorkspaceState = {
  kind: EWorkspaceKind;
  glyph: string;
  label: string;
};

/**
 * One worktree of a project, as a heading over the jobs standing in it.
 *
 * It is the SAME vocabulary a single job's page uses, deliberately: `⑂` means the same thing above a
 * run of rows as it does on one job's header, and two glyph tables for one concept would eventually
 * disagree. See `groupJobsByWorktree` in `worktree-groups.ts` for who builds these.
 */
export type WorktreeGroup = WorkspaceState & {
  path: string;
  /**
   * The branch itself, null on a detached head — NOT `label`, which is prose.
   *
   * The two are separate because `label` may carry `· locked` or read `detached at abc1234`, and
   * adoption writes this value into `Job.branch`, which `ShipService` later hands to `git push`. One
   * field serving both would have shipped a branch called `atlas/held · locked`.
   */
  branch: string | null;
  /** The main worktree — the tree the editor is probably open on, and where jobs run by default. */
  here: boolean;
  /**
   * How many jobs sit under it. Counted where the grouping happens rather than by the component,
   * because zero is the interesting value and it is the whole reason a group can be empty at all:
   * a worktree nothing is working in is a leak, and this is the only place it is ever visible.
   */
  jobCount: number;
};

/**
 * The one line that says where this job's agents are standing.
 *
 * In place is the NORMAL state, not a deficiency — a job takes a worktree late, when it earns one,
 * and most never do. So it is not warned about; it is simply named, along with the branch it will
 * commit to, because that is the fact you need before letting an agent write.
 *
 * A recorded worktree missing from disk IS warned about, and never downgraded to "in place". The
 * whole reason the worktree existed was to keep the agent out of the tree the fallback would put it
 * back into, so a quiet downgrade is the one genuinely dangerous answer here.
 */
export function workspaceState(args: {
  branch: string | null;
  workspacePath: string | null;
  /** What git says HEAD is on, wherever the job actually runs. Null on a detached head or no repo. */
  checkoutBranch: string | null;
  workspaceExists: boolean;
}): WorkspaceState {
  if (args.workspacePath && !args.workspaceExists) {
    return {
      kind: EWorkspaceKind.missing,
      glyph: '⚠',
      label: `worktree missing: ${args.workspacePath}`,
    };
  }

  if (args.workspacePath && args.branch) {
    return { kind: EWorkspaceKind.worktree, glyph: '⑂', label: args.branch };
  }

  // A branch with no worktree is normal rather than corrupt: `release()` removes the directory and
  // deliberately leaves the branch, which may be the only copy of the work.
  return {
    kind: EWorkspaceKind.inPlace,
    glyph: '⌂',
    label: args.checkoutBranch ? `${args.checkoutBranch} · in place` : 'in place',
  };
}
