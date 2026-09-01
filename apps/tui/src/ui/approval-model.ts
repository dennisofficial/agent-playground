import {
  answeredApproval,
  EDecision,
  eventsOfType,
  type ApprovalRequest,
  type CallId,
  type ERiskDimension,
  type Event,
  type EventDraft,
} from '@dltech/atlas-core'

export enum EApprovalChoice {
  Proceed = 'proceed',
  Decline = 'decline',
}

export type ApprovalOption = {
  choice: EApprovalChoice
  label: string
}

export type ApprovalQuestion = ApprovalRequest & {
  evidence?: readonly string[] | undefined
  dimensions?: readonly ERiskDimension[] | undefined
}

export type ApprovalState = {
  callId: CallId
  reason: string
  evidence: readonly string[]
  dimensions: readonly ERiskDimension[]
  selected: number
}

export const APPROVAL_HEADING = 'Atlas is asking before it runs this'

export const APPROVAL_EVIDENCE_HEADING = 'what fired'

export const APPROVAL_REWIND_NOTE =
  'Rewind stays shut until this is answered — Esc declines and reopens it.'

export const APPROVAL_OPTIONS: readonly ApprovalOption[] = Object.freeze([
  { choice: EApprovalChoice.Proceed, label: 'Proceed' },
  { choice: EApprovalChoice.Decline, label: 'Decline' },
])

const FIRST = 0

const LAST = APPROVAL_OPTIONS.length - 1

export function openApproval(question: ApprovalQuestion): ApprovalState {
  return {
    callId: question.callId,
    reason: question.reason,
    evidence: question.evidence ?? [],
    dimensions: question.dimensions ?? [],
    selected: FIRST,
  }
}

export function selectedOption(state: ApprovalState): ApprovalOption | undefined {
  return APPROVAL_OPTIONS[state.selected]
}

export function moveSelection(args: { state: ApprovalState; delta: number }): ApprovalState {
  const steps = Math.trunc(args.delta)
  if (steps === 0) return args.state

  const selected = Math.min(LAST, Math.max(FIRST, args.state.selected + steps))
  if (selected === args.state.selected) return args.state

  return { ...args.state, selected }
}

export function resolve(state: ApprovalState): EApprovalChoice | null {
  return selectedOption(state)?.choice ?? null
}

export const decisionOf = (choice: EApprovalChoice): EDecision =>
  choice === EApprovalChoice.Proceed ? EDecision.Allow : EDecision.Deny

export function answerDrafts(args: {
  callId: CallId
  choice: EApprovalChoice
}): readonly EventDraft[] {
  return [
    { type: 'approval-answered', callId: args.callId, decision: decisionOf(args.choice) },
  ]
}

function weighingOf(args: {
  events: readonly Event[]
  callId: CallId
}): Pick<ApprovalState, 'evidence' | 'dimensions'> {
  const judged = eventsOfType({ events: args.events, type: 'classifier-judged' })
    .filter((event) => event.callId === args.callId)
    .at(-1)

  if (judged === undefined) return { evidence: [], dimensions: [] }

  return { evidence: judged.details ?? [], dimensions: judged.dimensions }
}

export function unansweredApproval(args: {
  events: readonly Event[]
  callId: CallId
}): ApprovalQuestion | null {
  if (answeredApproval(args) !== undefined) return null

  const asked = eventsOfType({ events: args.events, type: 'approval-requested' })
    .filter((event) => event.callId === args.callId)
    .at(-1)

  if (asked === undefined) return null

  return { callId: asked.callId, reason: asked.reason, ...weighingOf(args) }
}
