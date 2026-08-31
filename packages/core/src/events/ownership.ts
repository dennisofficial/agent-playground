import type { Event } from './envelope'
import type { ThreadId } from './ids'

/**
 * A thread that inherits a prefix by reference reads rows belonging to its parent. Control flow —
 * what is pending, what is unapproved, whose turn it is — must only ever consider the rows the
 * thread itself owns, or a child pauses on a call it never made. Assembly reads the composed list,
 * because inherited context is the point of inheriting.
 */
export function rowsOwnedBy(args: {
  events: readonly Event[]
  threadId: ThreadId
}): readonly Event[] {
  return args.events.filter((event) => event.threadId === args.threadId)
}
