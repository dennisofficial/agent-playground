import { useCallback, useMemo, useState } from "react";
import type { OpenConversation } from "../app/conversation.service.js";
import type { ProjectRow } from "../app/workspace.service.js";

export type Route =
  | { name: "projects" }
  | { name: "jobs"; project: ProjectRow }
  | { name: "conversation"; project: ProjectRow; open: OpenConversation }
  | { name: "accounts" };

export type Navigation = {
  route: Route;
  /** False at the root, which is what lets a page decide whether to draw the `‹` affordance. */
  canPop: boolean;
  push: (route: Route) => void;
  pop: () => void;
  /** Swap the current route without deepening the stack — a redirect, not a step. */
  replace: (route: Route) => void;
  /**
   * Push, or pop back off it if it is already the current page. What a toggle key like `ctrl+a`
   * wants: pressing it twice returns you to where you were rather than stacking two accounts pages.
   */
  toggle: (route: Route) => void;
};

export function useNavigation(
  initial: Route = { name: "projects" },
): Navigation {
  const [stack, setStack] = useState<Route[]>([initial]);

  const push = useCallback(
    (route: Route) => setStack((s) => [...s, route]),
    [],
  );

  // The root is never popped — there is nothing behind it, and an empty stack has no page to draw.
  const pop = useCallback(
    () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
    [],
  );

  const replace = useCallback(
    (route: Route) => setStack((s) => [...s.slice(0, -1), route]),
    [],
  );

  const toggle = useCallback(
    (route: Route) =>
      setStack((s) => {
        const current = s[s.length - 1];
        if (current?.name === route.name)
          return s.length > 1 ? s.slice(0, -1) : s;
        return [...s, route];
      }),
    [],
  );

  const route = stack[stack.length - 1] ?? initial;

  return useMemo(
    () => ({ route, canPop: stack.length > 1, push, pop, replace, toggle }),
    [route, stack.length, push, pop, replace, toggle],
  );
}
