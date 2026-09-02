import { describe, expect, it } from 'bun:test'

import {
  EBeforeToolDecision,
  EClassifierMode,
  EConsultation,
  JudgePort,
  type BeforeToolOutcome,
  type Consultation,
} from '@dltech/atlas-core'

import { chainWith } from './chain-kit'
import { judgedIn, SIBLING } from './fixtures'

class UnreachableJudge extends JudgePort {
  async consult(): Promise<Consultation> {
    return { kind: EConsultation.Unreachable, fault: 'fetch failed' }
  }
}

const armedNudgeOver = (args: { judge?: JudgePort | undefined }): Promise<BeforeToolOutcome> =>
  chainWith({ mode: EClassifierMode.Nudge, judge: args.judge }).weigh()

describe('the classifier chain built without a judge', () => {
  it('cannot pause the operator, because nothing read the evidence', async () => {
    const outcome = await armedNudgeOver({ judge: undefined })

    expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
    expect(judgedIn(outcome).mode).toBe(EClassifierMode.Shadow)
  })

  it('still records what it would have asked about, so the silence is visible', async () => {
    const judged = judgedIn(await armedNudgeOver({ judge: undefined }))

    expect(judged.wouldAsk).toBe(true)
    expect(judged.details?.join(' ')).toContain(SIBLING)
  })

  it('pauses on the same call once a judge is bound and cannot be reached', async () => {
    const outcome = await armedNudgeOver({ judge: new UnreachableJudge() })

    expect(outcome.decision).toBe(EBeforeToolDecision.Ask)
  })
})
