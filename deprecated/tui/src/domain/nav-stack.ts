/**
 * The navigation stack, as five pure functions.
 *
 * Generic over the frame because `Route` names types from `app/` and `domain/` imports nothing —
 * the stack does not care what a page is, only that there is an order to them. Here rather than in
 * the hook so the rules worth asserting can be asserted without a terminal.
 *
 * **Every frame is one step, and `←` always means the frame below.** The stack is at most three
 * deep — the job list, the conversation you opened from it, and the job's own page above that —
 * and no page is ever entered by pushing two frames at once. An earlier design opened a job by
 * pushing `threads` AND `conversation` so that `←` revealed the job's page on the way out; it made
 * one keypress mean "leave" on every other page and "manage this job" on that one, which is exactly
 * the ambiguity this shape removes. Descending to the job's page is now its own key.
 *
 * **Scope is state, not depth.** There is exactly one job-list frame and it is the root. Widening
 * from one project to every project REPLACES it, and the project switcher `resetTo`s back down to
 * it, so choosing a project can never leave two identical-looking lists stacked on each other.
 */

/**
 * Zero frames is a legal no-op — it keeps callers from having to guard a conditional push, and the
 * "landed on" frame is always the last one given.
 */
export function pushFrames<T>(stack: readonly T[], ...frames: readonly T[]): T[] {
  return [...stack, ...frames];
}

/** The root is never popped: there is nothing behind it, and an empty stack has no page to draw. */
export function popFrame<T>(stack: readonly T[]): T[] {
  return stack.length > 1 ? stack.slice(0, -1) : [...stack];
}

/** A redirect rather than a step — swap where you are without recording that you were here. */
export function replaceFrame<T>(stack: readonly T[], frame: T): T[] {
  return [...stack.slice(0, -1), frame];
}

/**
 * Throw the stack away and stand on one frame.
 *
 * What choosing a project does. The switcher is reached from a list and lands you on a list, so it
 * is not a level you passed through and must not be left behind you — pushing the new list instead
 * would put a page identical to the one you are looking at two frames underneath it, which is the
 * whole confusion. Rewinding is also how the ONE-job-list invariant is kept: there is nothing left
 * for a second one to stack on.
 */
export function resetTo<T>(frame: T): T[] {
  return [frame];
}

/**
 * Push, or pop back off if it is already current. What a toggle key like `ctrl+a` wants: pressing
 * it twice returns you where you were rather than stacking a second page to escape out of twice.
 *
 * `isSame` is passed in because sameness here means "the same KIND of page" — two accounts routes
 * are the same door — and only the caller knows how its frames are named.
 */
export function toggleFrame<T>(
  stack: readonly T[],
  frame: T,
  isSame: (a: T, b: T) => boolean,
): T[] {
  const current = stack[stack.length - 1];
  if (current !== undefined && isSame(current, frame)) return popFrame(stack);
  return pushFrames(stack, frame);
}

/**
 * Unwind until the named page is on top, or the root is.
 *
 * What a tile does when a job is taken from it: it may be looking at the conversation, or at the
 * job's own page, and neither knows how deep it is. Popping a fixed number of frames would be a
 * guess, and a wrong guess strands you on a page whose job somebody else is now driving.
 *
 * Also how switching threads lands: unwind to the list, then push the conversation you chose. One
 * conversation frame in the stack, always — by structure rather than by a rule anyone has to keep.
 */
export function popToName<T>(
  stack: readonly T[],
  name: string,
  nameOf: (frame: T) => string,
): T[] {
  let next = [...stack];
  while (next.length > 1) {
    const top = next[next.length - 1];
    if (top !== undefined && nameOf(top) === name) break;
    next = next.slice(0, -1);
  }
  return next;
}
