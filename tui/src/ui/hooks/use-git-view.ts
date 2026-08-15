import { basename, relative } from "node:path";
import { useEffect, useState } from "react";
import type { HeaderGit } from "../../domain/conversation-header.js";
import { useServices } from "../services.js";

export type GitView = {
  /** The repository's own name. Null until the first read answers. */
  repo: string | null;
  git: HeaderGit;
};

const UNREAD: GitView = { repo: null, git: { cwdLabel: null, checkoutBranch: null } };

/**
 * What git ANSWERS about the directory this job's turns run in.
 *
 * Deliberately not `Job.branch`. Atlas orchestrates agents; it does not run the repository. An agent
 * is free to `git checkout`, `git worktree add`, rebase, or do nothing at all, and none of that goes
 * through Atlas — so the stored column records what Atlas last DID, while this reports what is
 * actually there. When the two disagree the observation is the true one, and the header has to say
 * the true one or the line identifying this conversation is wrong exactly when an agent is doing
 * its job.
 *
 * Re-read on `revision` — the message count — for the same reason `useTasks` is: only a turn changes
 * a branch, and a tool call is a message, so the transcript growing IS the signal. No polling clock,
 * and a read that is one message late shows a branch that is briefly stale.
 */
export function useGitView(args: { jobId: string; revision: number }): GitView {
  const { workspaceService } = useServices();
  const [view, setView] = useState<GitView>(UNREAD);

  useEffect(() => {
    // Guarded: switching jobs mid-read would otherwise land the old job's branch in the new job's
    // header — the same bug a shared conversation store once shipped.
    let live = true;
    void workspaceService.jobWorkspace(args.jobId).then((facts) => {
      if (!live) return;
      if (!facts) {
        setView(UNREAD);
        return;
      }
      setView({
        // The REPOSITORY, which is what the header means by `atlas`. Read off the project rather
        // than off the job's own directory: a job in a worktree lives at
        // `<project>/.worktrees/<slug>-<id8>`, so its basename is a slug that says nothing the
        // branch on the same line does not already say.
        repo: basename(facts.projectPath),
        git: {
          // Relative, and null for the root itself: `⌂` means turns run in the tree the editor is
          // open on, which is the one case worth flinching at.
          cwdLabel: facts.workspacePath
            ? relative(facts.projectPath, facts.workspacePath) || null
            : null,
          checkoutBranch: facts.checkoutBranch,
        },
      });
    });
    return () => {
      live = false;
    };
  }, [workspaceService, args.jobId, args.revision]);

  return view;
}
