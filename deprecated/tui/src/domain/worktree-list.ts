/**
 * `git worktree list --porcelain`, parsed.
 *
 * Pure, like the rest of `worktree.ts`'s neighbourhood, so the whole grammar is testable without a
 * repository — including the records that are awkward to produce on demand: a locked worktree, a
 * detached head, a gitdir pointing at a directory somebody deleted by hand.
 *
 * Non-porcelain `git worktree list` is deliberately not used. Its columns are aligned for a human
 * and a branch name long enough to hit the width would be truncated silently, which is exactly the
 * fact a caller is here for.
 */

/** One line of git's answer, before anything decides what it means for a job. */
export type GitWorktree = {
  /** Absolute, as git prints it. Not resolved through symlinks — see `pathKey` in `worktree-groups`. */
  path: string;
  /** `atlas/foo`, not `refs/heads/atlas/foo`. Null on a detached head or a bare repository. */
  branch: string | null;
  /** The commit, or null in a bare repository. Names a detached worktree that has no branch to. */
  head: string | null;
  bare: boolean;
  detached: boolean;
  /** Git refuses to prune or remove it. Usually removable media, sometimes a deliberate hold. */
  locked: boolean;
  /**
   * Its gitdir points at nothing — the directory is gone and only the administrative record is left.
   * Git reports this rather than hiding it, which is what makes a deleted worktree visible at all.
   */
  prunable: boolean;
};

const WORKTREE = 'worktree ';
const HEAD = 'HEAD ';
const BRANCH = 'branch ';
const REFS_HEADS = 'refs/heads/';

export function parseWorktreeList(porcelain: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  let current: GitWorktree | undefined;

  for (const raw of porcelain.split('\n')) {
    // `trimEnd` rather than `trim`: it takes the `\r` off a Windows checkout without touching the
    // leading character of a path. A path whose own last character is whitespace is unrepresentable
    // in this format anyway — that is what `--porcelain -z` exists for, and no caller needs it.
    const line = raw.trimEnd();

    // `worktree <path>` OPENS a record. Keying off the opener rather than off the blank line between
    // records means a missing or doubled separator cannot silently fuse two worktrees into one.
    if (line.startsWith(WORKTREE)) {
      current = {
        path: line.slice(WORKTREE.length),
        branch: null,
        head: null,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      };
      worktrees.push(current);
      continue;
    }

    // Attributes before the first `worktree` line cannot belong to anything. Git never emits them,
    // so this is a guard against a truncated read rather than a case to handle.
    if (!current) continue;

    if (line.startsWith(HEAD)) {
      current.head = line.slice(HEAD.length);
      continue;
    }
    if (line.startsWith(BRANCH)) {
      const ref = line.slice(BRANCH.length);
      current.branch = ref.startsWith(REFS_HEADS) ? ref.slice(REFS_HEADS.length) : ref;
      continue;
    }
    // `locked` and `prunable` carry an optional reason on the same line; the reason is git's own
    // prose and nothing here is better at saying it than the flag is.
    if (line === 'bare') current.bare = true;
    else if (line === 'detached') current.detached = true;
    else if (line === 'locked' || line.startsWith('locked ')) current.locked = true;
    else if (line === 'prunable' || line.startsWith('prunable ')) current.prunable = true;
  }

  return worktrees;
}
