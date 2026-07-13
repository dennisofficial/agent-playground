import type { ModuleRef } from '@nestjs/core';

/**
 * Resolve a "Merge PR" gate click through the driver's ONE merge path. Lazily imports {@link ThreadDriver}
 * (avoiding a static module cycle) and resolves it from the app-wide DI graph. `resolveMergeApprovalDurably`
 * delegates to `AutoMergeService.mergeNow`, which re-checks mergeability under its own in-flight guard, so a
 * stale/double click is a safe no-op. Returns whether the PR was actually merged by this call.
 *
 * Lives in its own file (not `web-surface.module.ts`) so the HTTP `WebSurfaceController` can import it for
 * the SYNCHRONOUS manual-merge path without creating a controller ⇄ module import cycle.
 */
export async function resolveMergeApproval(
  moduleRef: ModuleRef,
  jobId: string,
  ruledBy: string,
): Promise<boolean> {
  const { ThreadDriver } = await import('../driver/thread-driver.service.js');
  const driver = moduleRef.get(ThreadDriver, { strict: false });
  return await driver.resolveMergeApprovalDurably(jobId, ruledBy);
}
