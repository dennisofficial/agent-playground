import type { EDecision } from '../events/body'
import type { Event } from '../events/envelope'
import type { CallId } from '../events/ids'

export type ApprovalRequest = { callId: CallId; reason: string }

export type ApprovalAnswer = { decision: EDecision; editedInput?: unknown }

export type ApprovalResolver = (args: {
  events: readonly Event[]
  callId: CallId
}) => ApprovalAnswer | undefined
