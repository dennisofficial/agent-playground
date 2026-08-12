import { useCallback, type RefObject } from "react";
import type { ProjectRow } from "../../app/workspace.service.js";
import type { Navigation } from "../navigation.js";
import { useServices } from "../services.js";

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
  handleNew: (project: ProjectRow) => Promise<void>;
  handleStart: (start: { project: ProjectRow; text: string }) => Promise<void>;
} {
  const { workspaceService, jobStartService } = useServices();
  const { nav, focus, onError } = args;

  /**
   * `n` — the blank page a job may or may not come out of. The account check happens HERE rather
   * than on send, because the draft is that page's own state: sending you off to add an account
   * after you have typed a paragraph would unmount the page and take the paragraph with it.
   */
  const handleNew = useCallback(
    async (project: ProjectRow) => {
      try {
        if (!(await workspaceService.hasAccount())) {
          nav.push({ name: "accounts" });
          return;
        }
        nav.push({ name: "new-job", project });
      } catch (e) {
        onError((e as Error).message);
      }
    },
    [nav, onError, workspaceService],
  );

  /**
   * The first message, which creates everything: the job, its intake phase, its one thread, and the
   * message itself — in that order, so what the human typed IS the transcript's first line rather
   * than an answer to a brief it never saw.
   *
   * Replace THEN push, the same shape as switching threads: the blank page leaves the stack
   * entirely, so `←` out of the new conversation reaches the job's threads and then the list, and
   * there is never a second conversation-shaped frame to escape past.
   */
  const handleStart = useCallback(
    async (start: { project: ProjectRow; text: string }) => {
      try {
        const started = await jobStartService.start({
          projectId: start.project.id,
          firstMessage: start.text,
        });
        focus.current.job = started.job.id;
        nav.replace({
          name: "threads",
          project: start.project,
          job: started.job,
          cwd: started.cwd,
          currentThreadId: started.open.thread.id,
        });
        nav.push({
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
