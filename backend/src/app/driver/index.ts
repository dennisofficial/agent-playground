/**
 * W4 — the SECTION/PHASE DRIVER barrel. The deterministic, resumable `async` pipeline (the legible
 * replacement for v1's implicit status-FSM). The app imports `DriverModule`; W9 / tests reach the
 * `ThreadDriver` + its seams here. Zero v1 imports.
 */
export { renderPlan, type PlannedStep } from '../prompt-kit/messages/render-plan';
export { type MountMode, type MountSpec } from '../sandbox/container-paths';
export * from './base-move-mergeability-sync.service';
export {
  BuildLaneDeliveryService,
  LANE_SEEDER,
  type LaneSeedTarget,
  type LaneSeeder,
} from './build-lane-delivery.service';
export { BuildShipService, type ShipInput, type ShipOutcome } from './build-ship.service';
export * from './driver-store.service';
export * from './driver.module';
export {
  CADENCE_MS,
  GitStateReconciler,
  summarizeChecks,
  type PollTier,
} from './git-state-reconciler.service';
export * from './github-ci-state-sync.service';
export * from './github-pr-state-sync.service';
export * from './job-lifecycle.service';
export { JOB_TEARDOWN, type JobTeardownPort } from './job-teardown.port';
export {
  DRIVER_REPO,
  GitDriverRepoResolver,
  type DriverRepoResolver,
  type ResolvedRepo,
} from './repo-resolver';
export * from './thread-driver.service';
export { WorktreeHydrator } from './worktree-hydrator.service';
export { WorktreePathError, resolveSafeTarget } from './worktree-path-guard';
export { WorktreeProvisioner } from './worktree-provisioner.service';
