import type { EventDraft } from '../../events/body'
import type { ToolCall } from '../../tools/tool'
import { EBeforeToolDecision, type BeforeToolOutcome } from '../before-tool'
import { reachesSeverity, type RiskSignal } from './signals'
import { EClassifierMode, ETriage, type ClassifierPolicy, type Triage } from './triage'
import { dimensionCitedIn, EJudgment, type Verdict } from './verdict'

export enum EConsultation {
  Judged = 'judged',
  Unreachable = 'unreachable',
  Budgeted = 'budgeted',
}

export type Consultation =
  | { kind: EConsultation.Judged; verdict: Verdict; elapsedMs: number }
  | { kind: EConsultation.Unreachable; fault: string }
  | { kind: EConsultation.Budgeted; calls: number }

export type JudgedDraft = Extract<EventDraft, { type: 'classifier-judged' }>

const REASON_LIMIT = 400

const clipped = (text: string): string =>
  text.length <= REASON_LIMIT ? text : `${text.slice(0, REASON_LIMIT - 1)}…`

const detailsOf = ({ standing }: { standing: readonly RiskSignal[] }): string =>
  standing.map((signal) => signal.detail).join('; ')

function unconsultedReason({ triage }: { triage: Triage }): string {
  const fatigue = triage.fatigued ? ' (this thread has spent its interruptions)' : ''
  if (triage.standing.length > 0) return `${detailsOf({ standing: triage.standing })}${fatigue}`

  if (triage.cleared.length > 0) {
    const subjects = [...new Set(triage.cleared.map((cleared) => cleared.signal.subject))]
    return `a standing grant covers ${subjects.join(', ')}`
  }

  return 'nothing the probes watch for fired'
}

function reasonFor({
  triage,
  consultation,
}: {
  triage: Triage
  consultation: Consultation | undefined
}): string {
  if (consultation === undefined) return unconsultedReason({ triage })

  if (consultation.kind === EConsultation.Judged) return consultation.verdict.reason

  if (consultation.kind === EConsultation.Budgeted) {
    return `the judge budget for this turn is spent after ${consultation.calls} calls; ${detailsOf({ standing: triage.standing })}`
  }

  return `could not check this: ${consultation.fault}; ${detailsOf({ standing: triage.standing })}`
}

const judgedOf = ({
  consultation,
}: {
  consultation: Consultation | undefined
}): Verdict | undefined =>
  consultation?.kind === EConsultation.Judged ? consultation.verdict : undefined

function draftFor(args: {
  call: ToolCall
  triage: Triage
  consultation: Consultation | undefined
  policy: ClassifierPolicy
  elapsedMs: number
}): JudgedDraft {
  const { triage, consultation } = args
  const verdict = judgedOf({ consultation })
  const budgeted = consultation?.kind === EConsultation.Budgeted
  const reason = clipped(reasonFor({ triage, consultation }))

  return {
    type: 'classifier-judged',
    callId: args.call.callId,
    mode: args.policy.mode,
    triage: budgeted ? ETriage.Clear : triage.triage,
    judgment: verdict?.judgment ?? EJudgment.Proceed,
    dimensions: [...new Set(triage.standing.map((signal) => signal.dimension))],
    ...(verdict?.judgment === EJudgment.Check
      ? { judgedDimension: dimensionCitedIn({ reason, standing: triage.standing }) }
      : {}),
    signalIds: triage.standing.map((signal) => signal.id),
    reason,
    consulted: verdict !== undefined,
    elapsedMs: args.elapsedMs,
  }
}

function worthAskingUnreached({
  standing,
  policy,
}: {
  standing: readonly RiskSignal[]
  policy: ClassifierPolicy
}): boolean {
  return standing.some(
    (signal) =>
      signal.ungrantable ||
      reachesSeverity({ severity: signal.severity, floor: policy.askWhenUnreachableAtOrAbove }),
  )
}

export function adjudicate(args: {
  call: ToolCall
  triage: Triage
  consultation: Consultation | undefined
  policy: ClassifierPolicy
  elapsedMs: number
}): BeforeToolOutcome {
  const { call, triage, consultation, policy } = args
  const draft = draftFor(args)
  const drafts = [draft]

  const allow: BeforeToolOutcome = {
    decision: EBeforeToolDecision.Allow,
    input: call.input,
    drafts,
  }
  const ask: BeforeToolOutcome = { decision: EBeforeToolDecision.Ask, reason: draft.reason, drafts }

  if (policy.mode !== EClassifierMode.Nudge) return allow
  if (triage.triage !== ETriage.Consult) return allow
  if (consultation?.kind === EConsultation.Budgeted) return allow

  if (consultation?.kind === EConsultation.Judged) {
    return consultation.verdict.judgment === EJudgment.Check ? ask : allow
  }

  return worthAskingUnreached({ standing: triage.standing, policy }) ? ask : allow
}
