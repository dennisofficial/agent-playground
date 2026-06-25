/**
 * W4 — the SECTION/PHASE DRIVER barrel. The deterministic, resumable `async` pipeline (the legible
 * replacement for v1's implicit status-FSM). The app imports `DriverModule`; W9 / tests reach the
 * `SectionDriver` + its seams here. Zero v1 imports.
 */
export * from './driver.module';
export * from './section-driver.service';
export * from './driver-store.service';
export * from './thread-lifecycle.service';
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
  type PlannedPhase,
  type PlannedDecision,
  type PlanSectionInput,
} from './planner-llm';
