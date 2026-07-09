/**
 * W4 — the SECTION/PHASE DRIVER barrel. The deterministic, resumable `async` pipeline (the legible
 * replacement for v1's implicit status-FSM). The app imports `DriverModule`; W9 / tests reach the
 * `ThreadDriver` + its seams here. Zero v1 imports.
 */
export * from './driver.module';
export * from './thread-driver.service';
export * from './driver-store.service';
export * from './job-lifecycle.service';
export * from './github-pr-state-sync.service';
export { WorktreeProvisioner } from './worktree-provisioner.service';
export { WorktreeHydrator } from './worktree-hydrator.service';
export { type MountSpec, type MountMode } from '../sandbox/container-paths';
export { resolveSafeTarget, WorktreePathError } from './worktree-path-guard';
export { BuildShipService, type ShipInput, type ShipOutcome } from './build-ship.service';
export { PipelineAwarenessStore } from './pipeline-awareness.store';
export {
  pipelineStateSignature,
  renderPipelineStateSummary,
  renderAwarenessPrefix,
  type PipelineMarker,
} from './pipeline-awareness';
export {
  DRIVER_REPO,
  GitDriverRepoResolver,
  type DriverRepoResolver,
  type ResolvedRepo,
} from './repo-resolver';
export { renderPlan, type PlannedStep } from './render-plan';
export {
  LIVE_VERIFICATION_JUDGE,
  AnthropicLiveVerificationJudge,
  JudgeLiveVerificationChain,
  type LiveVerificationJudge,
  type LiveVerificationVerdict,
} from './live-verification-judge';
