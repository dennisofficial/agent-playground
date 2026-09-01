import type { EAgentStatus, EKilledBy, ThreadId } from '@dltech/atlas-core'

export type ChildContext = {
  tokens: number
  window: number
}

export type AgentSnapshot = {
  agentId: ThreadId
  spawnedBy: ThreadId
  agentType: string
  intent: string
  status: EAgentStatus
  killedBy?: EKilledBy | undefined
  turns: number
  toolCalls: number
  lastTool: string | undefined
  startedAt: string
  endedAt: string | undefined
  deliveredAt?: string | undefined
  context?: ChildContext | undefined
}

/**
 * A child thread the store has and the parent's log does not: the process died between opening the
 * child and recording the spawn. Nothing can be written for it — a reconstructed `agent-spawned`
 * could only land at `head + 1`, above every rewind target, where `unendedSpawns` would refuse
 * every rewind forever — so it is reported to the operator and left alone.
 */
export type UnloggedChild = {
  agentId: ThreadId
  agentType: string | undefined
  title: string | undefined
  startedAt: string
}

export type RecoveredAgents = {
  settled: readonly AgentSnapshot[]
  unlogged: readonly UnloggedChild[]
}
