
import { toCallId, toThreadId } from '../../../events/ids'
import { EToolEffect, type ToolCall } from '../../../tools/tool'
import { adjudicate, EConsultation, type Consultation, type JudgedDraft } from '../adjudicate'
import { ERiskDimension, ESeverity } from '../dimension'
import type { RiskSignal } from '../signals'
import {
  DEFAULT_CLASSIFIER_POLICY,
  EClassifierMode,
  ETriage,
  type ClassifierPolicy,
  type Triage,
} from '../triage'
import { EJudgment } from '../verdict'

export const CALL: ToolCall = {
  callId: toCallId('call-1'),
  name: 'bash',
  input: { command: 'git worktree remove --force ../eng-412-sidebar' },
  effect: EToolEffect.Destructive,
  threadId: toThreadId('thread-1'),
}

const signalOf = (args: {
  severity: ESeverity
  ungrantable?: boolean | undefined
  dimension?: ERiskDimension | undefined
}): RiskSignal => ({
  dimension: args.dimension ?? ERiskDimension.Contention,
  severity: args.severity,
  id: `probe:${args.severity}`,
  subject: 'worktree:eng-412-sidebar',
  detail: 'the sibling worktree carries three uncommitted changes',
  ungrantable: args.ungrantable ?? false,  unverified: false,

})

export const NOTE = signalOf({ severity: ESeverity.Note })
export const SERIOUS = signalOf({ severity: ESeverity.Serious })
export const SERIOUS_UNGRANTABLE = signalOf({ severity: ESeverity.Serious, ungrantable: true })
export const GRAVE = signalOf({ severity: ESeverity.Grave })

export const triageOver = (args: {
  triage: ETriage
  standing: readonly RiskSignal[]
  fatigued?: boolean | undefined
}): Triage => ({
  triage: args.triage,
  standing: args.standing,
  cleared: [],
  fatigued: args.fatigued ?? false,
})

export const CHECK: Consultation = {
  kind: EConsultation.Judged,
  verdict: {
    judgment: EJudgment.Check,
    reason: 'contention: eng-412-sidebar carries three uncommitted changes',
  },
  elapsedMs: 610,
}

export const PROCEED: Consultation = {
  kind: EConsultation.Judged,
  verdict: { judgment: EJudgment.Proceed, reason: '' },
  elapsedMs: 480,
}

export const UNREACHABLE: Consultation = { kind: EConsultation.Unreachable, fault: 'fetch failed' }
export const BUDGETED: Consultation = { kind: EConsultation.Budgeted, calls: 6 }

const policyIn = (mode: EClassifierMode): ClassifierPolicy => ({
  ...DEFAULT_CLASSIFIER_POLICY,
  mode,
})

export const decide = (args: {
  mode: EClassifierMode
  triage: Triage
  consultation: Consultation | undefined
}) =>
  adjudicate({
    call: CALL,
    triage: args.triage,
    consultation: args.consultation,
    policy: policyIn(args.mode),
    elapsedMs: 3,
  })

export const draftOf = (outcome: ReturnType<typeof decide>): JudgedDraft => {
  const draft = outcome.drafts?.[0]
  if (draft === undefined || draft.type !== 'classifier-judged') {
    throw new Error('the outcome carried no classifier row')
  }
  return draft
}

export const EVERY_TRIAGE: readonly Triage[] = [
  triageOver({ triage: ETriage.Clear, standing: [] }),
  triageOver({ triage: ETriage.Clear, standing: [SERIOUS], fatigued: true }),
  triageOver({ triage: ETriage.Consult, standing: [NOTE] }),
  triageOver({ triage: ETriage.Consult, standing: [SERIOUS] }),
  triageOver({ triage: ETriage.Consult, standing: [SERIOUS_UNGRANTABLE] }),
  triageOver({ triage: ETriage.Consult, standing: [GRAVE] }),
  triageOver({ triage: ETriage.Consult, standing: [NOTE, GRAVE] }),
]

export const EVERY_CONSULTATION: readonly (Consultation | undefined)[] = [
  undefined,
  PROCEED,
  CHECK,
  UNREACHABLE,
  BUDGETED,
]

export const EVERY_MODE: readonly EClassifierMode[] = [
  EClassifierMode.Off,
  EClassifierMode.Shadow,
  EClassifierMode.Nudge,
]
