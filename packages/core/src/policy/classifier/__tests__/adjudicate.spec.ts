import { describe, expect, it } from 'bun:test'

import { toCallId, toThreadId } from '../../../events/ids'
import { EToolEffect, type ToolCall } from '../../../tools/tool'
import { EBeforeToolDecision } from '../../before-tool'
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

const CALL: ToolCall = {
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
  ungrantable: args.ungrantable ?? false,
})

const NOTE = signalOf({ severity: ESeverity.Note })
const SERIOUS = signalOf({ severity: ESeverity.Serious })
const SERIOUS_UNGRANTABLE = signalOf({ severity: ESeverity.Serious, ungrantable: true })
const GRAVE = signalOf({ severity: ESeverity.Grave })

const triageOver = (args: {
  triage: ETriage
  standing: readonly RiskSignal[]
  fatigued?: boolean | undefined
}): Triage => ({
  triage: args.triage,
  standing: args.standing,
  cleared: [],
  fatigued: args.fatigued ?? false,
})

const CHECK: Consultation = {
  kind: EConsultation.Judged,
  verdict: {
    judgment: EJudgment.Check,
    reason: 'contention: eng-412-sidebar carries three uncommitted changes',
  },
  elapsedMs: 610,
}

const PROCEED: Consultation = {
  kind: EConsultation.Judged,
  verdict: { judgment: EJudgment.Proceed, reason: '' },
  elapsedMs: 480,
}

const UNREACHABLE: Consultation = { kind: EConsultation.Unreachable, fault: 'fetch failed' }
const BUDGETED: Consultation = { kind: EConsultation.Budgeted, calls: 6 }

const policyIn = (mode: EClassifierMode): ClassifierPolicy => ({
  ...DEFAULT_CLASSIFIER_POLICY,
  mode,
})

const decide = (args: {
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

const draftOf = (outcome: ReturnType<typeof decide>): JudgedDraft => {
  const draft = outcome.drafts?.[0]
  if (draft === undefined || draft.type !== 'classifier-judged') {
    throw new Error('the outcome carried no classifier row')
  }
  return draft
}

const EVERY_TRIAGE: readonly Triage[] = [
  triageOver({ triage: ETriage.Clear, standing: [] }),
  triageOver({ triage: ETriage.Clear, standing: [SERIOUS], fatigued: true }),
  triageOver({ triage: ETriage.Consult, standing: [NOTE] }),
  triageOver({ triage: ETriage.Consult, standing: [SERIOUS] }),
  triageOver({ triage: ETriage.Consult, standing: [SERIOUS_UNGRANTABLE] }),
  triageOver({ triage: ETriage.Consult, standing: [GRAVE] }),
  triageOver({ triage: ETriage.Consult, standing: [NOTE, GRAVE] }),
]

const EVERY_CONSULTATION: readonly (Consultation | undefined)[] = [
  undefined,
  PROCEED,
  CHECK,
  UNREACHABLE,
  BUDGETED,
]

const EVERY_MODE: readonly EClassifierMode[] = [
  EClassifierMode.Off,
  EClassifierMode.Shadow,
  EClassifierMode.Nudge,
]

describe('adjudicate', () => {
  it('never denies, for any combination of triage, consultation and mode', () => {
    for (const mode of EVERY_MODE) {
      for (const triage of EVERY_TRIAGE) {
        for (const consultation of EVERY_CONSULTATION) {
          const outcome = decide({ mode, triage, consultation })
          expect(outcome.decision).not.toBe(EBeforeToolDecision.Deny)
        }
      }
    }
  })

  it('allows everything in shadow, whatever the judge said', () => {
    for (const triage of EVERY_TRIAGE) {
      for (const consultation of EVERY_CONSULTATION) {
        const outcome = decide({ mode: EClassifierMode.Shadow, triage, consultation })
        expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
      }
    }
  })

  it('writes a row for every combination, so shadow mode has something to replay', () => {
    for (const mode of EVERY_MODE) {
      for (const triage of EVERY_TRIAGE) {
        for (const consultation of EVERY_CONSULTATION) {
          expect(draftOf(decide({ mode, triage, consultation })).mode).toBe(mode)
        }
      }
    }
  })

  it('asks when the judge checked and the nudge is armed', () => {
    const outcome = decide({
      mode: EClassifierMode.Nudge,
      triage: triageOver({ triage: ETriage.Consult, standing: [GRAVE] }),
      consultation: CHECK,
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Ask)
    expect(outcome.decision === EBeforeToolDecision.Ask ? outcome.reason : '').toContain(
      'eng-412-sidebar',
    )
  })

  it('allows when the judge proceeded', () => {
    const outcome = decide({
      mode: EClassifierMode.Nudge,
      triage: triageOver({ triage: ETriage.Consult, standing: [GRAVE] }),
      consultation: PROCEED,
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
  })

  it('asks when the judge was unreachable and an ungrantable signal survives', () => {
    const outcome = decide({
      mode: EClassifierMode.Nudge,
      triage: triageOver({ triage: ETriage.Consult, standing: [SERIOUS_UNGRANTABLE] }),
      consultation: UNREACHABLE,
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Ask)
    expect(draftOf(outcome).reason).toContain('fetch failed')
  })

  it('allows when the judge was unreachable and only a note survives', () => {
    const outcome = decide({
      mode: EClassifierMode.Nudge,
      triage: triageOver({ triage: ETriage.Consult, standing: [NOTE] }),
      consultation: UNREACHABLE,
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
  })

  it('asks when the judge was never bound and a grave signal survives', () => {
    const outcome = decide({
      mode: EClassifierMode.Nudge,
      triage: triageOver({ triage: ETriage.Consult, standing: [GRAVE] }),
      consultation: undefined,
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Ask)
    expect(draftOf(outcome).consulted).toBe(false)
  })

  it('records a spent judge budget as a clear, and lets the call through', () => {
    const outcome = decide({
      mode: EClassifierMode.Nudge,
      triage: triageOver({ triage: ETriage.Consult, standing: [SERIOUS] }),
      consultation: BUDGETED,
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Allow)

    const draft = draftOf(outcome)
    expect(draft.triage).toBe(ETriage.Clear)
    expect(draft.reason).toContain('budget for this turn is spent after 6 calls')
    expect(draft.signalIds).toEqual(['probe:serious'])
  })

  it('records the judged dimension apart from the reason, so pauses can be counted by rule', () => {
    const draft = draftOf(
      decide({
        mode: EClassifierMode.Nudge,
        triage: triageOver({ triage: ETriage.Consult, standing: [GRAVE] }),
        consultation: CHECK,
      }),
    )

    expect(draft.judgedDimension).toBe(ERiskDimension.Contention)
    expect(draft.judgment).toBe(EJudgment.Check)
    expect(draft.consulted).toBe(true)
  })

  it('leaves the judged dimension off a row nobody was asked about', () => {
    const draft = draftOf(
      decide({
        mode: EClassifierMode.Shadow,
        triage: triageOver({ triage: ETriage.Clear, standing: [] }),
        consultation: undefined,
      }),
    )

    expect(draft.judgedDimension).toBeUndefined()
    expect(draft.reason).toBe('nothing the probes watch for fired')
  })

  it('carries the call input forward untouched on every allow', () => {
    const outcome = decide({
      mode: EClassifierMode.Nudge,
      triage: triageOver({ triage: ETriage.Clear, standing: [] }),
      consultation: undefined,
    })

    expect(outcome.decision === EBeforeToolDecision.Allow ? outcome.input : undefined).toBe(
      CALL.input,
    )
  })
})
