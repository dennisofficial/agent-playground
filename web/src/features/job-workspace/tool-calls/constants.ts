/** The in-process MCP server the Atlas host-bridge tools are registered under (mirrors the backend). */
export const BRIDGE_SERVER_NAME = 'atlas-host-bridge';

/** Friendly labels for the Atlas host-bridge tools, keyed by their bare name. */
export const BRIDGE_TOOL_LABELS: Record<string, string> = {
  ask_question: 'Ask question',
  log_decision: 'Log decision',
  get_pipeline_state: 'Pipeline state',
  get_decision_record: 'Decision record',
  recall: 'Recall memory',
  remember: 'Remember',
  review_plan: 'Codex review',
  propose_plan: 'Propose plan',
  start_direct_build: 'Direct build',
  finalize_build: 'Finalize build',
  dispatch_build: 'Dispatch build',
  create_job: 'Create thread',
  create_ticket: 'Create ticket',
  list_tickets: 'List tickets',
  update_ticket: 'Update ticket',
  link_ticket_dependency: 'Link dependency',
  promote_ticket: 'Promote ticket',
};
