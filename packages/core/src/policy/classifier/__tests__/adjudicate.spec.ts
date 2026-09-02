import { describe, expect, it } from 'bun:test'

import { EBeforeToolDecision } from '../../before-tool'
import { EConsultation } from '../adjudicate'
import { ERiskDimension, ESeverity } from '../dimension'
import type { RiskSignal } from '../signals'
import { EClassifierMode, ETriage } from '../triage'
import { EJudgment } from '../verdict'
import {
  BUDGETED,
  CALL,
  CHECK,
  decide,
  draftOf,
  EVERY_CONSULTATION,
  EVERY_MODE,
  EVERY_TRIAGE,
  GRAVE,
  NOTE,
  PROCEED,
  SERIOUS,
  SERIOUS_UNGRANTABLE,
  triageOver,
  UNREACHABLE,
} from './adjudicate-fixtures'

describe('adjudicate', () => {
  it('never asks the operator, for any combination of triage, consultation and mode', () => {
    for (const mode of EVERY_MODE) {
      for (const triage of EVERY_TRIAGE) {
        for (const consultation of EVERY_CONSULTATION) {
          const outcome = decide({ mode, triage, consultation })
          expect(outcome.decision).not.toBe(EBeforeToolDecision.Ask)
        }
      }
    }
  })

  it('never refuses without saying what it would cost and what to do instead', () => {
    for (const mode of EVERY_MODE) {
      for (const triage of EVERY_TRIAGE) {
        for (const consultation of EVERY_CONSULTATION) {
          const outcome = decide({ mode, triage, consultation })
          if (outcome.decision !== EBeforeToolDecision.Deny) continue

          expect(outcome.reason.length).toBeGreaterThan(60)
          expect(outcome.reason).toContain('ask them to confirm')
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

  it('refuses the agent when the judge checked and the nudge is armed, naming the target', () => {
    const outcome = decide({
      mode: EClassifierMode.Nudge,
      triage: triageOver({ triage: ETriage.Consult, standing: [GRAVE] }),
      consultation: CHECK,
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Deny)
    const reason = outcome.decision === EBeforeToolDecision.Deny ? outcome.reason : ''
    expect(reason).toContain('eng-412-sidebar')
    expect(reason).toContain('their next message authorises it')
  })

  it('allows when the judge proceeded', () => {
    const outcome = decide({
      mode: EClassifierMode.Nudge,
      triage: triageOver({ triage: ETriage.Consult, standing: [GRAVE] }),
      consultation: PROCEED,
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
  })

  it('refuses when the judge was unreachable and an ungrantable signal survives', () => {
    const outcome = decide({
      mode: EClassifierMode.Nudge,
      triage: triageOver({ triage: ETriage.Consult, standing: [SERIOUS_UNGRANTABLE] }),
      consultation: UNREACHABLE,
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Deny)
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

  it('refuses when the judge was never bound and a grave signal survives', () => {
    const outcome = decide({
      mode: EClassifierMode.Nudge,
      triage: triageOver({ triage: ETriage.Consult, standing: [GRAVE] }),
      consultation: undefined,
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Deny)
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

describe('a doubt the reader could not settle', () => {
  const UNVERIFIED: RiskSignal = {
    dimension: ERiskDimension.Blast,
    severity: ESeverity.Grave,
    id: 'blast:unresolved-destructive-operand',
    subject: 'expansion:$T',
    detail: 'rm destroys operands that expand at run time ($T)',
    ungrantable: false,
    unverified: true,
  }

  it('reaches the judge, because only a model can read what the parser could not', () => {
    const outcome = decide({
      mode: EClassifierMode.Nudge,
      triage: triageOver({ triage: ETriage.Consult, standing: [UNVERIFIED] }),
      consultation: CHECK,
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Deny)
  })

  it('does not refuse on its own when the judge could not be reached', () => {
    const outcome = decide({
      mode: EClassifierMode.Nudge,
      triage: triageOver({ triage: ETriage.Consult, standing: [UNVERIFIED] }),
      consultation: UNREACHABLE,
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
  })

  it('still refuses when a verified signal survives beside it', () => {
    const outcome = decide({
      mode: EClassifierMode.Nudge,
      triage: triageOver({ triage: ETriage.Consult, standing: [UNVERIFIED, GRAVE] }),
      consultation: UNREACHABLE,
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Deny)
  })
})
