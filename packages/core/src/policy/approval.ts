import { EDecision } from '../events/body'
import type { Event } from '../events/envelope'
import type { CallId } from '../events/ids'
import { answeredApproval, eventsOfType } from '../events/projections'

export type ApprovalRequest = { callId: CallId; reason: string }

export type ApprovalAnswer = { decision: EDecision; editedInput?: unknown }

export type ApprovalResolver = (args: {
  events: readonly Event[]
  callId: CallId
}) => ApprovalAnswer | undefined

export enum EApprovalResolution {
  Dispatch = 'dispatch',
  Refused = 'refused',
}

export type ResolvedApproval =
  | { resolution: EApprovalResolution.Dispatch; input: unknown }
  | { resolution: EApprovalResolution.Refused; reason: string }

const DECLINED = 'the operator declined this call'

function askedReason({
  events,
  callId,
}: {
  events: readonly Event[]
  callId: CallId
}): string | undefined {
  return eventsOfType({ events, type: 'approval-requested' })
    .filter((event) => event.callId === callId)
    .at(-1)?.reason
}

export function resolveApproval({
  events,
  callId,
  input,
}: {
  events: readonly Event[]
  callId: CallId
  /** The pending call occurrence's own input — passed in because a reused call id makes a by-id lookup ambiguous. */
  input: unknown
}): ResolvedApproval {
  const answer = answeredApproval({ events, callId })

  if (answer?.decision === EDecision.Deny) {
    const asked = askedReason({ events, callId })
    return {
      resolution: EApprovalResolution.Refused,
      reason: asked === undefined ? DECLINED : `${DECLINED}: ${asked}`,
    }
  }

  if (answer?.decision === EDecision.Allow && answer.editedInput !== undefined) {
    return { resolution: EApprovalResolution.Dispatch, input: answer.editedInput }
  }

  return { resolution: EApprovalResolution.Dispatch, input }
}
