import { useCallback, useMemo, useState } from "react";
import {
  popFrame,
  popToName,
  pushFrames,
  replaceFrame,
  resetTo,
  toggleFrame,
} from "../domain/nav-stack.js";
import type { OpenConversation } from "../app/conversation.service.js";
import type { ProjectRow } from "../app/workspace.service.js";
import type { Job } from "../generated/prisma/client.js";

export type Route =
  /**
   * The project switcher. Not a level: it is opened from the job list, and choosing a project puts
   * you back on the job list scoped to it — see `reset`.
   */
  | { name: "projects" }
  /**
   * The one and only root. Null is the unscoped master list — every job, grouped by project — and a
   * project is the same page with the headers collapsed away.
   *
   * The scope moves by REPLACE, never by push: `←` widens from one project to all of them, and the
   * switcher rewinds here. Two of these frames is a bug, not a state.
   */
  | { name: "jobs"; project: ProjectRow | null }
  | { name: "conversation"; project: ProjectRow; open: OpenConversation }
  /**
   * A job that does not exist yet — one blank composer and nothing else. It carries no job and no
   * thread because there are none: the pending job lives entirely in the page's own state, so
   * popping this frame scratches it with nothing to clean up. Sending REPLACES this frame rather
   * than stacking on it — the blank page was never a place you were, and leaving it in the stack
   * would put a second conversation-shaped page behind the real one.
   */
  | {
      name: "new-job";
      project: ProjectRow;
      /**
       * An existing worktree the job will stand in the moment it exists — `⏎` on a worktree the jobs
       * list drew with no jobs under it. Carried on the ROUTE rather than held by the page for the
       * same reason the draft is not held by a service: walking away must scratch the whole intent,
       * and the worktree is part of what was intended.
       */
      adopt?: { branch: string; workspacePath: string };
    }
  /**
   * The job's phases and threads — the job's own page, and the DEEPEST frame, above the conversation
   * rather than beneath it.
   *
   * Reached by `→` on an empty composer or `ctrl+h`, and by opening a shipped job, whose cursor
   * thread is closed and so has no conversation to land on. It sat underneath the conversation once,
   * so that `←` revealed it; that made one key mean "leave" everywhere else and "manage this job"
   * here, and the job's page is now something you ask for rather than something you land on.
   */
  | {
      name: "threads";
      project: ProjectRow;
      job: Job;
      cwd: string;
      /** The thread the conversation above is on — the row the cursor lands on. */
      currentThreadId: string;
    }
  | { name: "accounts" };

export type ThreadsRoute = Extract<Route, { name: "threads" }>;

export type Navigation = {
  route: Route;
  /** False at the root, which is what lets a page decide whether to draw the `‹` affordance. */
  canPop: boolean;
  /** One step per call. Nothing pushes two frames any more — see `domain/nav-stack.ts`. */
  push: (...routes: Route[]) => void;
  pop: () => void;
  /** Swap the current route without deepening the stack — a redirect, not a step. */
  replace: (route: Route) => void;
  /**
   * Discard the stack and stand on one route. What the project switcher does: it is not a level you
   * came through, so it must not be left behind you, and the list it lands on is the root.
   */
  reset: (route: Route) => void;
  /**
   * Push, or pop back off it if it is already the current page. What a toggle key like `ctrl+a`
   * wants: pressing it twice returns you to where you were rather than stacking two accounts pages.
   */
  toggle: (route: Route) => void;
  /**
   * Unwind to the named page. For an exit that is not a step back: a tile whose job was taken from
   * it may be on the conversation or on the job's page, and popping a fixed count would be a guess.
   */
  popTo: (name: Route["name"]) => void;
};

/**
 * The root is the job list, never a picker you pass through. Launching inside a repository REPLACES
 * it with that repository's list rather than stacking one on top: `←` widens back out to every job
 * by swapping the scope, so the widest list is always the root and the root always has nothing
 * behind it. Stacking them made `‹` appear on a page whose `←` could not go anywhere.
 */
export function useNavigation(
  initial: Route = { name: "jobs", project: null },
): Navigation {
  const [stack, setStack] = useState<Route[]>([initial]);

  const push = useCallback(
    (...routes: Route[]) => setStack((s) => pushFrames(s, ...routes)),
    [],
  );

  const pop = useCallback(() => setStack((s) => popFrame(s)), []);

  const replace = useCallback(
    (route: Route) => setStack((s) => replaceFrame(s, route)),
    [],
  );

  const reset = useCallback(
    (route: Route) => setStack(() => resetTo(route)),
    [],
  );

  const toggle = useCallback(
    (route: Route) =>
      setStack((s) => toggleFrame(s, route, (a, b) => a.name === b.name)),
    [],
  );

  const popTo = useCallback(
    (name: Route["name"]) =>
      setStack((s) => popToName(s, name, (frame) => frame.name)),
    [],
  );

  const route = stack[stack.length - 1] ?? initial;

  return useMemo(
    () => ({
      route,
      canPop: stack.length > 1,
      push,
      pop,
      replace,
      reset,
      toggle,
      popTo,
    }),
    [route, stack.length, push, pop, replace, reset, toggle, popTo],
  );
}
