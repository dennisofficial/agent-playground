import type { EAgentStart } from '../agents/start'
import type { EAgentStatus } from '../agents/status'
import type { ImagePart, ReasoningPart, TextPart } from '../message/parts'
import type { EKilledBy, EShellStatus } from '../shells/status'
import type { CallId, ThreadId } from './ids'

export enum ECompactionAnchor {
  Prefix = 'prefix',
  Suffix = 'suffix',
}

export enum EDecision {
  Allow = 'allow',
  Deny = 'deny',
}

export enum EWorktreeExit {
  Keep = 'keep',
  Remove = 'remove',
}

export enum EMessageOrigin {
  Operator = 'operator',
  ParentAgent = 'parent-agent',
}

export const saidBy = (said: { via?: EMessageOrigin | undefined }): EMessageOrigin =>
  said.via ?? EMessageOrigin.Operator

export type AssistantPart = TextPart | ReasoningPart

export type SaidImage = {
  path: string
  mediaType: string
  data: string
  width?: number | undefined
  height?: number | undefined
}

export type EventBody =
  | {
      type: 'user-said'
      text: string
      via?: EMessageOrigin | undefined
      images?: readonly SaidImage[] | undefined
    }
  | { type: 'assistant-said'; parts: readonly AssistantPart[]; interrupted?: boolean | undefined }
  | { type: 'tool-called'; callId: CallId; name: string; input?: unknown; ordinal: number }
  | {
      type: 'tool-result'
      callId: CallId
      name: string
      output?: unknown
      modelText?: string | undefined
      modelParts?: readonly (TextPart | ImagePart)[] | undefined
      error?: { message: string } | undefined
      interrupted?: boolean | undefined
    }
  | { type: 'tool-denied'; callId: CallId; name: string; reason: string; interrupted?: boolean | undefined }
  | { type: 'approval-requested'; callId: CallId; reason: string }
  | { type: 'approval-answered'; callId: CallId; decision: EDecision; editedInput?: unknown }
  | { type: 'context-loaded'; slot: string; key: string; content: string; triggeredBy?: string | undefined }
  | { type: 'nudge'; text: string; lifetimeSteps: number }
  | { type: 'worktree-entered'; path: string; branch: string; base: string }
  | { type: 'worktree-exited'; path: string; action: EWorktreeExit }
  | {
      type: 'background-shell-ended'
      shellId: string
      command: string
      description?: string | undefined
      status: EShellStatus
      killedBy?: EKilledBy | undefined
      exitCode?: number | undefined
      output: string
      droppedCharacters: number
      remainingCharacters: number
    }
  | {
      type: 'background-shell-awaiting-input'
      shellId: string
      command: string
      description?: string | undefined
      output: string
      droppedCharacters: number
      remainingCharacters: number
    }
  | {
      type: 'agent-spawned'
      agentId: ThreadId
      agentType: string
      intent: string
      mode: EAgentStart
    }
  | {
      type: 'agent-ended'
      agentId: ThreadId
      agentType: string
      intent: string
      status: EAgentStatus
      killedBy?: EKilledBy | undefined
      prose: string
      turns: number
      toolCalls: number
    }
  | {
      type: 'history-compacted'
      anchor: ECompactionAnchor
      fromSeq: number
      throughSeq: number
      summary: string
      replaced: number
    }

export type EventDraft = EventBody

export type EventType = EventBody['type']
