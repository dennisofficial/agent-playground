import { describe, expect, it } from 'bun:test'

import { EBeforeToolDecision } from '../../before-tool'
import { ERiskDimension } from '../dimension'
import { EClassifierMode, ETriage } from '../triage'
import {
  CHECK,
  decide,
  draftOf,
  EVERY_CONSULTATION,
  EVERY_TRIAGE,
  GRAVE,
  SERIOUS,
  SERIOUS_UNGRANTABLE,
  triageOver,
} from './adjudicate-fixtures'

describe('the row a shadow run leaves behind', () => {
  it('records the pause it would have caused, so shadow measures something', () => {
    const shadowed = decide({
      mode: EClassifierMode.Shadow,
      triage: triageOver({ triage: ETriage.Consult, standing: [SERIOUS] }),
      consultation: CHECK,
    })

    expect(shadowed.decision).toBe(EBeforeToolDecision.Allow)
    expect(draftOf(shadowed).wouldAsk).toBe(true)
  })

  it('agrees with itself once armed', () => {
    for (const triage of EVERY_TRIAGE) {
      for (const consultation of EVERY_CONSULTATION) {
        const armed = decide({ mode: EClassifierMode.Nudge, triage, consultation })
        const watching = decide({ mode: EClassifierMode.Shadow, triage, consultation })

        expect(draftOf(watching).wouldAsk).toBe(draftOf(armed).wouldAsk ?? false)
        expect(draftOf(armed).wouldAsk).toBe(armed.decision === EBeforeToolDecision.Ask)
      }
    }
  })

  it('says the thread went quiet rather than leaving the silence unexplained', () => {
    const draft = draftOf(
      decide({
        mode: EClassifierMode.Nudge,
        triage: triageOver({ triage: ETriage.Clear, standing: [GRAVE], fatigued: true }),
        consultation: undefined,
      }),
    )

    expect(draft.fatigued).toBe(true)
    expect(draft.wouldAsk).toBe(false)
    expect(draft.reason).toContain('this thread has spent its interruptions')
  })

  it('carries the surviving signals own words, which the drawer shows as evidence', () => {
    const draft = draftOf(
      decide({
        mode: EClassifierMode.Nudge,
        triage: triageOver({ triage: ETriage.Consult, standing: [SERIOUS, GRAVE] }),
        consultation: CHECK,
      }),
    )

    expect(draft.details).toEqual([SERIOUS.detail, GRAVE.detail])
  })

  it('names what the operator could stop being asked about, subject by subject', () => {
    const draft = draftOf(
      decide({
        mode: EClassifierMode.Nudge,
        triage: triageOver({ triage: ETriage.Consult, standing: [SERIOUS, GRAVE] }),
        consultation: CHECK,
      }),
    )

    expect(draft.grantables).toEqual([
      { subject: SERIOUS.subject, dimensions: [ERiskDimension.Contention] },
    ])
  })

  it('offers nothing when one surviving signal can never be waived in advance', () => {
    const draft = draftOf(
      decide({
        mode: EClassifierMode.Nudge,
        triage: triageOver({ triage: ETriage.Consult, standing: [SERIOUS, SERIOUS_UNGRANTABLE] }),
        consultation: CHECK,
      }),
    )

    expect(draft.grantables).toEqual([])
  })

  it('carries no evidence lines when nothing survived triage', () => {
    const draft = draftOf(
      decide({
        mode: EClassifierMode.Nudge,
        triage: triageOver({ triage: ETriage.Clear, standing: [] }),
        consultation: undefined,
      }),
    )

    expect(draft.details).toEqual([])
    expect(draft.grantables).toBeUndefined()
    expect(draft.fatigued).toBe(false)
  })
})
