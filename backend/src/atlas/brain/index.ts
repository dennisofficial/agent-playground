/**
 * W3 — the ATLAS BRAIN. Public barrel: the module + the two seams (the `STIMULUS_CONSUMER` it binds via
 * `TriageService`, and the `JOB_DISPATCHER` output seam W4 overrides), plus the services/types later
 * workstreams consume. Zero v1 imports.
 */
export * from './brain.module';
export * from './brain.types';
export * from './triage.service';
export * from './conversational-brain.service';
export * from './decision-approval.service';
export * from './brain-store.service';
export * from './scoping-investigator.service';
export {
  JOB_DISPATCHER,
  LoggingJobDispatcher,
  type JobDispatcher,
} from './job-dispatcher';
export {
  ATLAS_BRAIN_LLM,
  AnthropicBrainLlm,
  parseGrillArgs,
  type BrainLlm,
  type TriageInput,
  type GrillInput,
} from './brain-llm';
