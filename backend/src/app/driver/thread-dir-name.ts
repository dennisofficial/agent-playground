import { slugify } from '@workspace/shared';

/**
 * The human-readable directory name for a thread's completion trail — `<ordinal>-<slug of brief>` (e.g.
 * `010-fix-driver-store-columns`) instead of the raw uuid, since this is a worktree artifact a human or the
 * brain may browse. Gap-numbered ordinals keep threads sorted in read order.
 *
 * Kept in its own dependency-free file (no NestJS imports) so both the driver (`thread-driver.service.ts`)
 * and the brain (`agent-session-manager.service.ts`) can import it directly without pulling in each other's
 * full service graph — `driver.module.ts` already imports `../brain` for `JOB_DISPATCHER`, so a brain-side
 * import of the heavy `thread-driver.service.ts` file creates a real module load-order cycle.
 */
export function threadDirName(thread: { ordinal: number; brief: string }): string {
  return `${String(thread.ordinal).padStart(3, '0')}-${slugify(thread.brief)}`;
}
