import type { EAgentStatus, ThreadId } from '@dltech/atlas-core'

export type AgentSnapshot = {
  agentId: ThreadId
  spawnedBy: ThreadId
  agentType: string
  intent: string
  status: EAgentStatus
  turns: number
  toolCalls: number
  lastTool: string | undefined
  startedAt: string
  endedAt: string | undefined
}
