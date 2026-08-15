import { useCallback, type RefObject } from "react";
import type { ProjectRow } from "../../app/workspace.service.js";
import { claimService } from "./use-claim.js";
import type { Navigation } from "../navigation.js";
import { useServices } from "../services.js";

/** An existing worktree, as the jobs list names one. See `WorktreeService.adopt`. */
type Adopt = { branch: string; workspacePath: string };

/**
 * Creating a job, in the two moves it now takes: open a blank page, and send a message into it.
 *
 * Apart from `App` because both moves are decisions rather than wiring — WHERE the account check
 * happens and WHICH frame the new conversation replaces are the two things that make creation cost
 * one keypress and leave nothing behind when it does not happen.
 */
export function useNewJob(args: {
  nav: Navigation;
  /** The cursor hint for the list you came from, so a created job is where you left it. */
  focus: RefObject<{ project?: string; job?: string }>;
  onError: (message: string) => void;
}): {
  handleNew: (project: ProjectRow, adopt?: Adopt) => Promise<void>;
  handleStart: (start: {
    project: ProjectRow;
    text: string;
    adopt?: Adopt;
  }) => Promise<void>;
} {
  const { workspaceService, jobStartService } = useServices();
  const { nav, focus, onError } = args;

  /**
   * `n` — the blank page a job may or may not come out of. The account check happens HERE rather
   * than on send, because the draft is that page's own state: sending you off to add an account
   * after you have typed a paragraph would unmount the page and take the paragraph with it.
   */
  const handleNew = useCallback(
    async (project: ProjectRow, adopt?: Adopt) => {
      try {
        if (!(await workspaceService.hasAccount())) {
          nav.push({ name: "accounts" });
          return;
        }
        nav.push({ name: "new-job", project, ...(adopt ? { adopt } : {}) });
      } catch (e) {
        onError((e as Error).message);
      }
    },
    [nav, onError, workspaceService],
  );

  /**
   * The first message, which creates everything: the job, its generic phase, its one thread, and the
   * message itself — in that order, so what the human typed IS the transcript's first line rather
   * than an answer to a brief it never saw.
   *
   * REPLACES the blank page rather than stacking on it — the page you were never really on leaves the
   * stack entirely, so `←` out of the new conversation reaches the list it was created from and there
   * is never a second conversation-shaped frame to escape past. One frame, exactly as opening an
   * existing job pushes one: a job created is a job opened, and the two must not land differently.
   */
  const handleStart = useCallback(
    async (start: { project: ProjectRow; text: string; adopt?: Adopt }) => {
      try {
        const started = await jobStartService.start({
          projectId: start.project.id,
          firstMessage: start.text,
          // Adoption happens INSIDE creation, between the row and the first turn, so the opening
          // message already runs in the worktree. Entering afterwards would run turn one in the
          // project path — the exact tree the worktree was chosen to stay out of.
          ...(start.adopt ? { adopt: start.adopt } : {}),
        });
        focus.current.job = started.job.id;
        // Nothing to take — the job did not exist a moment ago — but the claim is acquired at the
        // sites that MEAN to hold a job rather than in a mount effect, and this is one of them.
        claimService.acquire(started.job.id);
        nav.replace({
          name: "conversation",
          project: start.project,
          open: started.open,
        });
      } catch (e) {
        onError((e as Error).message);
      }
    },
    [focus, jobStartService, nav, onError],
  );

  return { handleNew, handleStart };
}
