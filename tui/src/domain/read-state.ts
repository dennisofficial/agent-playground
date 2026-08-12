/**
 * Read state — the fact (*when you last looked*), never the label (*unread*).
 *
 * Its grain is the THREAD, not the job: you read the builder and not the planner, and a job-level
 * timestamp would lie about both. The whole of it is three comparisons, kept here so the list, the
 * divider and the write-through rule cannot disagree about what "seen" means.
 */

/** Newest message newer than the last time you reached the bottom. */
export function hasUnseen(args: {
  lastMessageAt: Date | null;
  lastSeenAt: Date | null;
}): boolean {
  if (!args.lastMessageAt) return false;
  if (!args.lastSeenAt) return true;
  return args.lastMessageAt.getTime() > args.lastSeenAt.getTime();
}

/**
 * Where the `─── new ───` rule goes: the index of the oldest message you have not seen, or `-1`
 * when there is nothing new.
 *
 * A thread never opened returns `0` — everything is new — and the caller draws no divider above the
 * first message, because a rule at the very top of a transcript separates nothing from something.
 * That check lives at the call site rather than here so the index stays honest.
 */
export function firstUnseenIndex(args: {
  messages: readonly { createdAt: Date }[];
  lastSeenAt: Date | null;
}): number {
  if (args.messages.length === 0) return -1;
  if (!args.lastSeenAt) return 0;
  const seenUntil = args.lastSeenAt.getTime();
  return args.messages.findIndex((message) => message.createdAt.getTime() > seenUntil);
}

/**
 * Is the transcript sitting at the bottom.
 *
 * This is the mechanic the whole ticket rests on: `lastSeenAt` is written on REACHING the bottom,
 * not on mount, or opening a 400-message transcript would mark it read without you reading a line.
 * The arithmetic mirrors OpenTUI's own sticky check (`scrollTop >= scrollHeight - viewport.height`),
 * including the case where the content is shorter than the viewport and there is nothing to scroll
 * — that IS the bottom.
 */
export function isPinnedToBottom(args: {
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
}): boolean {
  const maxScrollTop = Math.max(0, args.scrollHeight - args.viewportHeight);
  return args.scrollTop >= maxScrollTop;
}
