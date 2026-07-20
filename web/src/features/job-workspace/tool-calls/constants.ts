import {
  ATLAS_HOST_BRIDGE_TOOLS,
  BRIDGE_SERVER_NAME,
  type AtlasHostBridgeTool,
} from '@workspace/shared';

export { ATLAS_HOST_BRIDGE_TOOLS, BRIDGE_SERVER_NAME };
export type { AtlasHostBridgeTool };

/**
 * Friendly labels for the Atlas host-bridge tools, keyed by their bare name. Typed as an EXHAUSTIVE
 * map over the shared `AtlasHostBridgeTool` contract, so adding/renaming/removing a host tool that
 * isn't reflected here is a compile error — no more silent drift.
 */
export const BRIDGE_TOOL_LABELS: Record<AtlasHostBridgeTool, string> = {
  task_create: 'Add task',
  task_update: 'Update task',
  task_list: 'Tasks',
  task_get: 'Task',
  report_verification: 'Report verification',
  get_pipeline_state: 'Pipeline state',
  get_decision_record: 'Decision record',
  recall: 'Recall memory',
  remember: 'Remember',
  forget: 'Forget memory',
  update_memory: 'Update memory',
  ask_question: 'Ask question',
  create_decision: 'Lock decision',
  withdraw_question: 'Withdraw question',
  withdraw_plan: 'Withdraw plan',
  withdraw_ship: 'Withdraw ship review',
  set_job_kind: 'Set job kind',
  update_decision: 'Update decision',
  delete_decision: 'Delete decision',
  review_plan: 'Codex review',
  propose_plan: 'Propose plan',
  dispatch_build: 'Dispatch build',
  hold_build: 'Hold build',
  start_direct_build: 'Direct build',
  finalize_build: 'Finalize build',
  create_job: 'Create job',
  list_jobs: 'List jobs',
  link_job_dependency: 'Link job dependency',
  reset_sandbox: 'Reset sandbox',
  finish_onboarding: 'Finish onboarding',
};

/**
 * Friendly label for a bare host-bridge tool name, falling back to the raw name for anything not in
 * the map. Contains the `string`→union lookup so callers (which hold arbitrary tool-name strings)
 * don't have to widen `BRIDGE_TOOL_LABELS` and lose its exhaustiveness guarantee.
 */
export function bridgeToolLabel(bare: string): string {
  return (BRIDGE_TOOL_LABELS as Record<string, string>)[bare] ?? bare;
}
