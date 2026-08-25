/**
 * What `atlas` means by "here".
 *
 * The opening premise of the redesign was Claude Code's — open where you are — and it did not
 * survive contact with how Atlas is used: the terminal is as often sitting in `~` as in a repo,
 * because the tiles are long-lived and nobody `cd`s between tickets. So cwd was demoted from ROOT
 * to HINT, and this function is the whole of that demotion.
 *
 * cwd biases the job list and never gates it. The rule that earns the module is the third one:
 * an implicit cwd outside any repository resolves to NOTHING rather than to a project, because
 * minting a project for the home directory would leave a junk row at the top of the list forever.
 * A folder named on the command line is different in kind — that is a statement of intent, and it
 * becomes a project whether or not git has heard of it.
 */

export enum ELaunchScope {
  /** Show this project's jobs, flat, with the group headers gone. */
  project = 'project',
  /** Show every job, grouped by project. Create nothing. */
  global = 'global',
}

export type LaunchScope =
  | { kind: ELaunchScope.project; path: string }
  | { kind: ELaunchScope.global };

/**
 * `gitRoot` is the MAIN worktree of whichever path is under consideration — resolved by the caller,
 * since asking git is IO. Passing the main worktree rather than the toplevel is what makes launching
 * inside `.worktrees/foo` land on the repo instead of minting a second project for the same code.
 */
export function launchScope(args: {
  explicitPath: string | null;
  cwd: string;
  gitRoot: string | null;
}): LaunchScope {
  if (args.explicitPath) {
    return { kind: ELaunchScope.project, path: args.gitRoot ?? args.explicitPath };
  }
  if (args.gitRoot) return { kind: ELaunchScope.project, path: args.gitRoot };
  return { kind: ELaunchScope.global };
}
