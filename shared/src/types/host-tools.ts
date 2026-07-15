/**
 * The atlas-host-bridge tool surface — the CONTRACT between the backend (which registers the host
 * tools) and the web console (which renders/labels their calls). Single-sourced here so the two
 * sides can't drift: before this existed the tool set lived only implicitly as
 * `Object.keys(AgentSessionManager.buildTools())` at runtime and was re-typed by hand in the web
 * label map, which is how a dead `log_decision` key and a handful of unlabeled tools crept in.
 *
 * `ATLAS_HOST_BRIDGE_TOOLS` is the UNION across all session kinds (normal build brain, onboarding,
 * review) of every tool the host bridge registers — i.e. the keys of `buildTools()` MINUS the
 * separate `workspace-profile` server's tools (`WORKSPACE_PROFILE_TOOL_NAMES`, owned by
 * `backend/src/app/sandbox/image/workspace-profile-bridge-options.ts`). A backend drift-guard test
 * asserts the registered set equals this list, and the web label map is typed
 * `Record<AtlasHostBridgeTool, string>` so a missing/stale label is a compile error.
 */

/** The in-process MCP server name the host-bridge tools are registered under (`mcp__<server>__<tool>`). */
export const BRIDGE_SERVER_NAME = 'atlas-host-bridge';

/**
 * Every atlas-host-bridge tool name, across all session kinds. Keep in sync with
 * `AgentSessionManager.buildTools()`; the drift-guard spec fails CI if they diverge.
 */
export const ATLAS_HOST_BRIDGE_TOOLS = [
  'task_create',
  'task_update',
  'task_list',
  'task_get',
  'report_verification',
  'get_pipeline_state',
  'get_decision_record',
  'recall',
  'remember',
  'forget',
  'update_memory',
  'ask_question',
  'create_decision',
  'withdraw_question',
  'withdraw_plan',
  'withdraw_ship',
  'set_job_kind',
  'update_decision',
  'delete_decision',
  'review_plan',
  'propose_plan',
  'dispatch_build',
  'hold_build',
  'start_direct_build',
  'finalize_build',
  'create_job',
  'list_jobs',
  'link_job_dependency',
  'reset_sandbox',
  'finish_onboarding',
] as const;

/** A single atlas-host-bridge tool name. */
export type AtlasHostBridgeTool = (typeof ATLAS_HOST_BRIDGE_TOOLS)[number];
