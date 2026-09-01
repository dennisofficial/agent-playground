import { describe, expect, it } from 'bun:test'

import { EBeforeToolDecision } from '../../before-tool'
import { EConsultation } from '../adjudicate'
import { ERiskDimension } from '../dimension'
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
