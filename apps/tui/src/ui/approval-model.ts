import {
  answeredApproval,
  EDecision,
  EGrantScope,
  eventsOfType,
  type ApprovalRequest,
  type CallId,
  type ERiskDimension,
  type Event,
  type EventDraft,
  type GrantOffer,
} from '@dltech/atlas-core'

export enum EApprovalChoice {
  Proceed = 'proceed',
  Always = 'always',
  Decline = 'decline',
}

export type ApprovalOption = {
  choice: EApprovalChoice
  label: string
}

export type ApprovalQuestion = ApprovalRequest & {
  evidence?: readonly string[] | undefined
  dimensions?: readonly ERiskDimension[] | undefined
  grantables?: readonly GrantOffer[] | undefined
}

export type ApprovalState = {
  callId: CallId
  reason: string
  evidence: readonly string[]
  dimensions: readonly ERiskDimension[]
  grantables: readonly GrantOffer[]
  selected: number
}

export const APPROVAL_HEADING = 'Atlas is asking before it runs this'

export const APPROVAL_EVIDENCE_HEADING = 'what fired'

export const APPROVAL_REWIND_NOTE =
  'Rewind stays shut until this is answered — Esc declines and reopens it.'

const PROCEED: ApprovalOption = { choice: EApprovalChoice.Proceed, label: 'Proceed' }

const DECLINE: ApprovalOption = { choice: EApprovalChoice.Decline, label: 'Decline' }

export const APPROVAL_OPTIONS: readonly ApprovalOption[] = Object.freeze([PROCEED, DECLINE])

export const STOP_ASKING_KEY = 'a'

export const subjectsNamed = (grantables: readonly GrantOffer[]): string =>
  grantables.map((offer) => offer.subject).join(', ')

const stopAskingOption = (grantables: readonly GrantOffer[]): ApprovalOption => ({
  choice: EApprovalChoice.Always,
  label: `Proceed, and stop asking about ${subjectsNamed(grantables)}`,
})

export function optionsFor(state: ApprovalState): readonly ApprovalOption[] {
  if (state.grantables.length === 0) return APPROVAL_OPTIONS
  return [PROCEED, stopAskingOption(state.grantables), DECLINE]
}

export const offersToStopAsking = (state: ApprovalState): boolean => state.grantables.length > 0

const FIRST = 0

export function openApproval(question: ApprovalQuestion): ApprovalState {
  return {
    callId: question.callId,
    reason: question.reason,
    evidence: question.evidence ?? [],
    dimensions: question.dimensions ?? [],
    grantables: question.grantables ?? [],
    selected: FIRST,
  }
}

export function selectedOption(state: ApprovalState): ApprovalOption | undefined {
  return optionsFor(state)[state.selected]
}

export function moveSelection(args: { state: ApprovalState; delta: number }): ApprovalState {
  const steps = Math.trunc(args.delta)
  if (steps === 0) return args.state

  const last = optionsFor(args.state).length - 1
  const selected = Math.min(last, Math.max(FIRST, args.state.selected + steps))
  if (selected === args.state.selected) return args.state

  return { ...args.state, selected }
}

export function resolve(state: ApprovalState): EApprovalChoice | null {
  return selectedOption(state)?.choice ?? null
}

export const decisionOf = (choice: EApprovalChoice): EDecision =>
  choice === EApprovalChoice.Decline ? EDecision.Deny : EDecision.Allow

export const grantIdFor = (args: { callId: CallId; subject: string }): string =>
  `grant:${args.callId}:${args.subject}`

const grantDrafts = (args: {
  callId: CallId
  grantables: readonly GrantOffer[]
  reason: string
}): readonly EventDraft[] =>
  args.grantables.map((offer) => ({
    type: 'permission-granted',
    grantId: grantIdFor({ callId: args.callId, subject: offer.subject }),
    dimensions: offer.dimensions,
    scope: EGrantScope.Thread,
    subject: offer.subject,
    reason: args.reason,
  }))

export function answerDrafts(args: {
  callId: CallId
  choice: EApprovalChoice
  grantables?: readonly GrantOffer[] | undefined
  reason?: string | undefined
}): readonly EventDraft[] {
  const answered: EventDraft = {
    type: 'approval-answered',
    callId: args.callId,
    decision: decisionOf(args.choice),
  }
  if (args.choice !== EApprovalChoice.Always) return [answered]

  return [
    answered,
    ...grantDrafts({
      callId: args.callId,
      grantables: args.grantables ?? [],
      reason: args.reason ?? '',
    }),
  ]
}

function weighingOf(args: {
  events: readonly Event[]
  callId: CallId
}): Pick<ApprovalState, 'evidence' | 'dimensions' | 'grantables'> {
  const judged = eventsOfType({ events: args.events, type: 'classifier-judged' })
    .filter((event) => event.callId === args.callId)
    .at(-1)

  if (judged === undefined) return { evidence: [], dimensions: [], grantables: [] }

  return {
    evidence: judged.details ?? [],
    dimensions: judged.dimensions,
    grantables: judged.grantables ?? [],
  }
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
