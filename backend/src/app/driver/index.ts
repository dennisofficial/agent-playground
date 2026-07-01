/**
 * W4 — the SECTION/PHASE DRIVER barrel. The deterministic, resumable `async` pipeline (the legible
 * replacement for v1's implicit status-FSM). The app imports `DriverModule`; W9 / tests reach the
 * `TrackDriver` + its seams here. Zero v1 imports.
 */
export * from './driver.module';
export * from './track-driver.service';
export * from './driver-store.service';
export * from './job-lifecycle.service';
export { WorktreeProvisioner } from './worktree-provisioner.service';
export { WorktreeHydrator } from './worktree-hydrator.service';
export {
  loadWorktreeManifest,
  type WorktreeManifest,
  type MountSpec,
  type SecretSpec,
  type MountMode,
} from './worktree-manifest';
export {
  resolveSafeTarget,
  resolveSafeSource,
  WorktreePathError,
} from './worktree-path-guard';
export { BuildShipService, type ShipInput, type ShipResult } from './build-ship.service';
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
export {
  PLANNER_LLM,
  AnthropicPlannerLlm,
  PlannerChains,
  renderPlanContext,
  type PlannerLlm,
  type PlannedStep,
  type PlannedDecision,
  type PlanTrackInput,
} from './planner-llm';
