import { useCallback, useMemo, useState } from "react";
import {
  popFrame,
  popToName,
  pushFrames,
  replaceFrame,
  toggleFrame,
} from "../domain/nav-stack.js";
import type { OpenConversation } from "../app/conversation.service.js";
import type { ProjectRow } from "../app/workspace.service.js";
import type { Job } from "../generated/prisma/client.js";

export type Route =
  | { name: "projects" }
  /** Null is the unscoped master list — every job, grouped by project. It is the root. */
  | { name: "jobs"; project: ProjectRow | null }
  | { name: "conversation"; project: ProjectRow; open: OpenConversation }
  /**
   * A job that does not exist yet — one blank composer and nothing else. It carries no job and no
   * thread because there are none: the pending job lives entirely in the page's own state, so
   * popping this frame scratches it with nothing to clean up. Sending REPLACES this frame rather
   * than stacking on it — the blank page was never a place you were, and leaving it in the stack
   * would put a second conversation-shaped page behind the real one.
   */
  | { name: "new-job"; project: ProjectRow }
  /**
   * The job's phases and threads — the job's own page, and the frame the conversation sits on top
   * of. Pushed when the job opens, revealed by popping the conversation off, never reached any
   * other way.
   */
  | {
      name: "threads";
      project: ProjectRow;
      job: Job;
      cwd: string;
      /** The thread the conversation above is on — the row the cursor lands on. */
      currentThreadId: string;
    }
  /**
   * The job's long-lived processes. It carries the id and the title rather than the `Job` because
   * that is all the page draws, and taking the row would couple `navigation.ts` to Prisma for a page
   * that never reads the database. The title is a snapshot either way — a rename while you sit here
   * does not reach the trail, exactly as it does not reach the conversation route's copy.
   */
  | { name: "services"; jobId: string; jobTitle: string }
  | { name: "accounts" };

export type ThreadsRoute = Extract<Route, { name: "threads" }>;

/**
 * The job this tile is IN, and therefore the one it holds the claim on.
 *
 * A tile holds the job it has open: the conversation, the job's own page and its services are all
 * inside it, so `←` between them changes nothing. Browsing holds nothing, which means a job you left
 * ten seconds ago is immediately takeable — you are demonstrably not in it.
 *
 * The services page belongs on this list precisely because it is the page you SIT on, watching
 * something run. Dropping the claim there would let another terminal take the job silently while you
 * watch, and the takeover notice you would have got is rendered by the hook that just unmounted.
 *
 * A function over the route rather than a chain in `app.tsx` because it is a rule about which pages
 * mean "in a job" — and the way it fails is silent, in a lock nothing on screen draws.
 */
export function heldJobId(route: Route): string | null {
  if (route.name === "conversation") return route.open.job.id;
  if (route.name === "threads") return route.job.id;
  if (route.name === "services") return route.jobId;
  return null;
}

export type Navigation = {
  route: Route;
  /** False at the root, which is what lets a page decide whether to draw the `‹` affordance. */
  canPop: boolean;
  /**
   * Several at once is the point, not a convenience: opening a job pushes `threads` and then
   * `conversation`, so you land on the conversation while `←` still walks back through the job.
   */
  push: (...routes: Route[]) => void;
  pop: () => void;
  /** Swap the current route without deepening the stack — a redirect, not a step. */
  replace: (route: Route) => void;
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
 * The root is the unscoped job list, never a picker you pass through. Launching inside a repository
 * pushes the scoped list ON TOP of it, which is what makes `←` widen back out to everything rather
 * than dead-end at the project you happened to be standing in.
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
      toggle,
      popTo,
    }),
    [route, stack.length, push, pop, replace, toggle, popTo],
  );
}
