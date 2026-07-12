import { slugify } from '@workspace/shared';

/**
 * The human-readable directory name for a thread's completion trail — `<ordinal>-<slug of brief>` (e.g.
 * `010-fix-driver-store-columns`) instead of the raw uuid, since this is a worktree artifact a human or the
 * brain may browse. Gap-numbered ordinals keep threads sorted in read order.
 *
 * Lives in the zero-dep prompt-kit hub (its only dependency is `slugify`) so the seed catalog can render it
 * WITHOUT the hub taking an upward value dependency on the driver area. The driver
 * (`thread-driver.service.ts`) and brain import it from here, keeping the edge pointing the correct way
 * (services → hub) and avoiding the load-order cycle a heavy cross-service import would create.
 */
export function threadDirName(thread: { ordinal: number; brief: string }): string {
  return `${String(thread.ordinal).padStart(3, '0')}-${slugify(thread.brief)}`;
}
