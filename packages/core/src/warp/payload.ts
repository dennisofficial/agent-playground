export enum EWarpAgentEvent {
  SessionStart = 'session_start',
  PromptSubmit = 'prompt_submit',
  ToolComplete = 'tool_complete',
  PermissionRequest = 'permission_request',
  IdlePrompt = 'idle_prompt',
  Stop = 'stop',
}

const WARP_AGENT_NAME = 'atlas'
const WARP_NOTIFICATION_TARGET = 'warp://cli-agent'
const NOTIFICATION_TEXT_LIMIT = 200

export function truncateForWarpNotification({
  text,
  limit = NOTIFICATION_TEXT_LIMIT,
}: {
  text: string
  limit?: number
}): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 3)}...`
}

export interface WarpEventExtras {
  pluginVersion?: string
  query?: string
  response?: string
  summary?: string
  toolName?: string
  toolInput?: unknown
}

export function buildWarpPayload({
  event,
  sessionId,
  cwd,
  protocolVersion,
  extras = {},
}: {
  event: EWarpAgentEvent
  sessionId: string
  cwd: string
  protocolVersion: number
  extras?: WarpEventExtras
}): string {
  const project = cwd.split('/').filter(Boolean).pop() ?? ''
  const payload: Record<string, unknown> = {
    v: protocolVersion,
    agent: WARP_AGENT_NAME,
    event,
    session_id: sessionId,
    cwd,
    project,
  }
  if (extras.pluginVersion !== undefined) payload.plugin_version = extras.pluginVersion
  if (extras.query !== undefined) payload.query = truncateForWarpNotification({ text: extras.query })
  if (extras.response !== undefined) {
    payload.response = truncateForWarpNotification({ text: extras.response })
  }
  if (extras.summary !== undefined) payload.summary = extras.summary
  if (extras.toolName !== undefined) payload.tool_name = extras.toolName
  if (extras.toolInput !== undefined) payload.tool_input = extras.toolInput
  return JSON.stringify(payload)
}

export function buildWarpOscSequence({ payloadJson }: { payloadJson: string }): string {
  return `\x1b]777;notify;${WARP_NOTIFICATION_TARGET};${payloadJson}\x07`
}
