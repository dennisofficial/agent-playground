/** DI token for the {@link JobTeardownPort}. */
export const JOB_TEARDOWN = Symbol('JOB_TEARDOWN');

/**
 * A NARROW seam onto the driver's physical job teardown, for callers OUTSIDE the driver module.
 *
 * `OrganizationService.deleteOrg` must reclaim every job's container + git worktree (side effects no DB
 * cascade can do) before dropping the org row — work that lives in `JobLifecycleService.deleteJobDeep`,
 * inside the driver. A STATIC import of that service from `org/` closes an ES module cycle
 * (org → driver/job-lifecycle → onboarding barrel → onboarding controllers → org-membership.guard → org),
 * which is why it was previously reached via `ModuleRef.get(..., { strict: false })` + a dynamic
 * `import()` — the service-locator anti-pattern (dependency hidden from the constructor, untyped,
 * untestable without a real DI container).
 *
 * This token replaces that: it is defined in a LEAF file with zero imports, and bound in the @Global
 * `DriverModule` to the concrete `JobLifecycleService` via `useExisting`. Injecting the token therefore
 * needs no `imports: [DriverModule]` edge (it is global) and no import of the driver's source — so the
 * cycle never forms, and the dependency is now an explicit, typed constructor parameter.
 */
export interface JobTeardownPort {
  /**
   * Physically tear down ONE job: reclaim its container + git worktree, then delete the thread row
   * (cascading its children). Idempotent — a missing job is a no-op.
   */
  deleteJobDeep(jobId: string, orgId: string): Promise<void>;
}
