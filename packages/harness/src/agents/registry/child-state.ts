import {
  type SaidImage,
  attributedStop,
  EAgentStatus,
  type AssistantPart,
  type EKilledBy,
  type EventDraft,
  type RosteredAgent,
  type ThreadId,
} from '@dltech/atlas-core'

import type { AgentSnapshot, ChildContext } from './snapshot'

export type ChildState = {
  agentId: ThreadId
  spawnedBy: ThreadId
  agentType: string
  intent: string
  status: EAgentStatus
  killedBy: EKilledBy | undefined
  turns: number
  toolCalls: number
  lastTool: string | undefined
  lastText: string
  startedAt: string
  endedAt: string | undefined
  deliveredAt: string | undefined
  abort: AbortController
  pending: SteerMessage[]
  context: ChildContext | undefined
}

export type SteerMessage = { text: string; images?: readonly SaidImage[] | undefined }

export const isStepping = (child: ChildState): boolean => child.status === EAgentStatus.Running

export function recoveredChild({
  agent,
  spawnedBy,
  at,
}: {
  agent: RosteredAgent
  spawnedBy: ThreadId
  at: string
}): ChildState {
  return {
    agentId: agent.agentId,
    spawnedBy,
    agentType: agent.agentType,
    intent: agent.intent,
    status: agent.status,
    killedBy: agent.killedBy,
    turns: agent.turns,
    toolCalls: agent.toolCalls,
    lastTool: undefined,
    lastText: agent.prose,
    startedAt: agent.spawnedAt ?? at,
    endedAt: agent.endedAt,
    deliveredAt: undefined,
    abort: new AbortController(),
    pending: [],
    context: undefined,
  }
}

export function snapshotOf(child: ChildState): AgentSnapshot {
  return {
    agentId: child.agentId,
    spawnedBy: child.spawnedBy,
    agentType: child.agentType,
    intent: child.intent,
    status: child.status,
    killedBy: attributedStop({ status: child.status, killedBy: child.killedBy }),
    turns: child.turns,
    toolCalls: child.toolCalls,
    lastTool: child.lastTool,
    startedAt: child.startedAt,
    endedAt: child.endedAt,
    deliveredAt: child.deliveredAt,
    context: child.context,
  }
}

export function agentEndedDraft(child: ChildState): EventDraft {
  return {
    type: 'agent-ended',
    agentId: child.agentId,
    agentType: child.agentType,
    intent: child.intent,
    status: child.status,
    killedBy: attributedStop({ status: child.status, killedBy: child.killedBy }),
    prose: child.lastText,
    turns: child.turns,
    toolCalls: child.toolCalls,
  }
}

const spokenText = (parts: readonly AssistantPart[]): string =>
  parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim()

export function recordContext({
  child,
  tokens,
  window,
}: {
  child: ChildState
  tokens: number
  window: number
}): void {
  child.context = { tokens, window }
}

export function recordProgress({
  child,
  drafts,
}: {
  child: ChildState
  drafts: readonly EventDraft[]
}): void {
  for (const draft of drafts) {
    if (draft.type === 'assistant-said') {
      child.turns += 1
      const said = spokenText(draft.parts)
      if (said !== '') child.lastText = said
      continue
    }

    if (draft.type === 'tool-called') {
      child.toolCalls += 1
      child.lastTool = draft.name
    }
  }
}
