import {
  EAgentStatus,
  type AssistantPart,
  type EventDraft,
  type ThreadId,
} from '@dltech/atlas-core'

import type { AgentType } from '../types'
import type { AgentSnapshot } from './snapshot'

export type ChildState = {
  agentId: ThreadId
  spawnedBy: ThreadId
  agentType: AgentType
  intent: string
  status: EAgentStatus
  turns: number
  toolCalls: number
  lastTool: string | undefined
  lastText: string
  startedAt: string
  endedAt: string | undefined
  abort: AbortController
  pending: string[]
}

export const isStepping = (child: ChildState): boolean => child.status === EAgentStatus.Running

export function snapshotOf(child: ChildState): AgentSnapshot {
  return {
    agentId: child.agentId,
    spawnedBy: child.spawnedBy,
    agentType: child.agentType.name,
    intent: child.intent,
    status: child.status,
    turns: child.turns,
    toolCalls: child.toolCalls,
    lastTool: child.lastTool,
    startedAt: child.startedAt,
    endedAt: child.endedAt,
  }
}

export function agentEndedDraft(child: ChildState): EventDraft {
  return {
    type: 'agent-ended',
    agentId: child.agentId,
    agentType: child.agentType.name,
    intent: child.intent,
    status: child.status,
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
