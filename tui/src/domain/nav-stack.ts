/**
 * The navigation stack, as four pure functions.
 *
 * Generic over the frame because `Route` names types from `app/` and `domain/` imports nothing —
 * the stack does not care what a page is, only that there is an order to them. Here rather than in
 * the hook so the one rule worth asserting can be asserted without a terminal: opening a job pushes
 * TWO frames and `pop` unwinds them one at a time.
 *
 * **Descending may skip levels; ascending never does.** That asymmetry is the whole navigation
 * design. Jumping straight to the conversation is what makes a tile feel like one job rather than a
 * hierarchy to walk, and leaving `threads` underneath is what makes `←` mean "manage this job"
 * instead of "leave it". Neither needs a special case, because the skip happens on the way IN.
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
