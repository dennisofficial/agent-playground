import type { ReasoningPart, TextPart } from '../message/parts'
import type { CallId, SnapshotId } from './ids'

export enum EDecision {
  Allow = 'allow',
  Deny = 'deny',
}

export type AssistantPart = TextPart | ReasoningPart

export type EventBody =
  | { type: 'user-said'; text: string }
  | { type: 'assistant-said'; parts: readonly AssistantPart[]; interrupted?: boolean | undefined }
  | { type: 'tool-called'; callId: CallId; name: string; input: unknown; ordinal: number }
  | {
      type: 'tool-result'
      callId: CallId
      name: string
      output: unknown
      modelText?: string | undefined
      error?: { message: string } | undefined
      snapshotId?: SnapshotId | undefined
    }
  | { type: 'tool-denied'; callId: CallId; name: string; reason: string }
  | { type: 'approval-requested'; callId: CallId; reason: string }
  | { type: 'approval-answered'; callId: CallId; decision: EDecision; editedInput?: unknown }
  | { type: 'context-loaded'; slot: string; key: string; content: string; triggeredBy?: string | undefined }
  | { type: 'nudge'; text: string; lifetimeSteps: number }

export type EventDraft = EventBody

export type EventType = EventBody['type']
