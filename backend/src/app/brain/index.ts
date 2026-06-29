/**
 * R3 — the ATLAS BRAIN. Public barrel: the module + the two seams (the `BRAIN_SINK` it binds over
 * `AgentSessionManager`, and the `JOB_DISPATCHER` output seam W4 overrides), plus the services/types
 * later workstreams consume. Zero v1 imports.
 */
export * from './brain.module';
export * from './brain.types';
export * from './agent-session-manager.service';
export * from './decision-approval.service';
export * from './brain-store.service';
export * from './plan-review.service';
export {
  JOB_DISPATCHER,
  LoggingJobDispatcher,
  type JobDispatcher,
} from './job-dispatcher';
