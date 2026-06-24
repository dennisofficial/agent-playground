/**
 * R3 — the ATLAS BRAIN. Public barrel: the module + the two seams (the `STIMULUS_CONSUMER` it binds
 * via `StimulusRouter`, and the `JOB_DISPATCHER` output seam W4 overrides), plus the services/types
 * later workstreams consume. Zero v1 imports.
 */
export * from './brain.module';
export * from './brain.types';
export * from './stimulus-router.service';
export * from './event-triage.service';
export * from './agent-session-manager.service';
export * from './decision-approval.service';
export * from './brain-store.service';
export * from './plan-review.service';
export {
  JOB_DISPATCHER,
  LoggingJobDispatcher,
  type JobDispatcher,
} from './job-dispatcher';
export {
  BRAIN_LLM,
  AnthropicBrainLlm,
  type BrainLlm,
  type TriageInput,
} from './brain-llm';
