import type { EAgentStart } from '../agents/start'
import type { EAgentStatus } from '../agents/status'
import type { ImagePart, ReasoningPart, TextPart } from '../message/parts'
import type { ERiskDimension } from '../policy/classifier/dimension'
import type { EGrantScope, GrantOffer } from '../policy/classifier/grant'
import type { EClassifierMode, ETriage } from '../policy/classifier/triage'
import type { EJudgment, EVerdictFault } from '../policy/classifier/verdict'
import type { EServiceStatus } from '../services/status'
import type { EKilledBy, EShellStatus } from '../shells/status'
import type { ETldrStatus } from '../tldr/status'
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
  | {
      type: 'worktree-entered'
      path: string
      branch: string
      base?: string | undefined
      adopted?: boolean | undefined
    }
  | { type: 'worktree-exited'; path: string; action: EWorktreeExit; returnTo?: string | undefined }
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
      type: 'background-shell-matched'
      shellId: string
      command: string
      description?: string | undefined
      pattern: string
      lines: string
      matchCount: number
      watchDisarmed?: boolean | undefined
    }
  | {
      type: 'service-ended'
      serviceId: string
      command: string
      description?: string | undefined
      status: EServiceStatus
      killedBy?: EKilledBy | undefined
      exitCode?: number | undefined
      logPath: string
      tail: string
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
  | {
      type: 'classifier-judged'
      callId: CallId
      mode: EClassifierMode
      triage: ETriage
      judgment: EJudgment
      dimensions: readonly ERiskDimension[]
      judgedDimension?: ERiskDimension | undefined
      verdictFault?: EVerdictFault | undefined
      signalIds: readonly string[]
      details?: readonly string[] | undefined
      grantables?: readonly GrantOffer[] | undefined
      reason: string
      consulted: boolean
      wouldAsk?: boolean | undefined
      fatigued?: boolean | undefined
      elapsedMs: number
    }
  | {
      type: 'permission-granted'
      grantId: string
      dimensions: readonly ERiskDimension[]
      scope: EGrantScope
      subject: string
      reason: string
    }
  | { type: 'permission-revoked'; grantId: string }
  | {
      type: 'tldr-written'
      anchorSeq: number
      throughSeq: number
      text: string
      modelId: string
      status?: ETldrStatus | undefined
    }

export type EventDraft = EventBody

export type EventType = EventBody['type']

export const SURVIVES_SUMMARY: readonly EventType[] = [
  'context-loaded',
  'permission-granted',
  'permission-revoked',
]

export const survivesSummary = (type: EventType): boolean => SURVIVES_SUMMARY.includes(type)
