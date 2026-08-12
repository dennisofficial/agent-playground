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

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
