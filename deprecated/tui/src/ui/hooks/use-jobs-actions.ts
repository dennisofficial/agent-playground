import { useCallback } from "react";
import type { ProjectRow } from "../../app/workspace.service.js";
import type { WorktreeGroup } from "../../domain/worktree.js";
import type { JobRow } from "../../store/job.repository.js";
import type { View } from "../pages/jobs-chrome.js";
import { useServices } from "../services.js";

/**
 * Everything the jobs list DOES, as opposed to what it shows.
 *
 * Apart from the page for the same reason `useJobsKeys` is: the page is now state, layout and one
 * cursor, and five write paths sitting in the middle of it hid the thing worth checking — that every
 * one of them leaves the filter mode, clears the last error, and reloads. They are also the five
 * places a worktree and a job mean different things, which is easier to audit in one screen.
 *
 * Each returns void and reports failure through `onError`. Nothing here throws into a render.
 */
export function useJobsActions(args: {
  project: ProjectRow | null;
  view: View;
  leaveMode: () => void;
  reload: () => Promise<void>;
  onError: (message: string | null) => void;
  /** `n`, and `⏎` on an empty worktree — the blank page, optionally with a home already chosen. */
  onNew: (adopt?: { branch: string; workspacePath: string }) => void;
}): {
  handleNew: () => void;
  handleNewIn: (group: WorktreeGroup) => void;
  releaseWorktree: (group: WorktreeGroup) => void;
  remove: (job: JobRow) => void;
  shelve: (job: JobRow) => void;
} {
  const { workspaceService, attentionService, worktreeService } = useServices();
  const { project, view, leaveMode, reload, onError, onNew } = args;

  // No create mode: `n` leaves this page for a blank conversation, and the job is created by the
  // first message sent there. The title prompt that used to live here was ceremony charged before
  // anyone knew whether there was a job at all — and it was injected as the opening message anyway.
  const handleNew = useCallback(() => {
    leaveMode();
    onNew();
  }, [leaveMode, onNew]);

  /**
   * `⏎` on a worktree with no jobs — the same blank page `n` opens, with the job's home already
   * decided. Nothing is written here: adoption happens inside creation, from the first message, so
   * walking away from the draft still leaves no job and no record of one.
   */
  const handleNewIn = useCallback(
    (group: WorktreeGroup) => {
      leaveMode();
      // `group.branch`, never `group.label` — the label is prose and may read `atlas/held · locked`.
      // A detached worktree has no branch to adopt and none for `ship` to push at the end of the job,
      // so it is refused here rather than written and discovered much later.
      if (group.branch === null) {
        onError(`${group.path} has no branch — check one out in it first`);
        return;
      }
      onNew({ branch: group.branch, workspacePath: group.path });
    },
    [leaveMode, onError, onNew],
  );

  /**
   * `x` on a worktree with no jobs. The directory goes and the branch stays — and the refusals that
   * make that safe live in `WorktreeService.releasePath`, not here: a row drawn `no jobs` is only
   * empty relative to the list on screen, and this page is the wrong place to learn otherwise.
   */
  const releaseWorktree = useCallback(
    (group: WorktreeGroup) => {
      leaveMode();
      onError(null);
      if (!project) return;
      void worktreeService
        .releasePath({ repoPath: project.path, worktreePath: group.path })
        .then(() => reload())
        .catch((e: Error) => onError(e.message));
    },
    [leaveMode, onError, project, reload, worktreeService],
  );

  const remove = useCallback(
    (job: JobRow) => {
      leaveMode();
      onError(null);
      void workspaceService
        .deleteJob(job.id)
        .then(() => reload())
        .catch((e: Error) => onError(e.message));
    },
    [leaveMode, onError, reload, workspaceService],
  );

  // No confirm on either of these: archiving destroys nothing and restoring un-destroys nothing,
  // and one keypress back is the whole point of having a shelf instead of a second delete.
  const shelve = useCallback(
    (job: JobRow) => {
      onError(null);
      const move =
        view === "archived"
          ? attentionService.restoreJob(job.id)
          : attentionService.archiveJob(job.id);
      void move.then(() => reload()).catch((e: Error) => onError(e.message));
    },
    [attentionService, onError, reload, view],
  );

  return { handleNew, handleNewIn, releaseWorktree, remove, shelve };
}
