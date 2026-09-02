import { describe, expect, it } from 'bun:test'

import {
  EBeforeToolDecision,
  EClassifierMode,
  EConsultation,
  EJudgment,
  JudgePort,
  type Consultation,
} from '@dltech/atlas-core'

import { chainWith } from './chain-kit'
import { judgedIn, SIBLING } from './fixtures'

const CHECKED = `contention: ${SIBLING} carries uncommitted work`

class CheckingJudge extends JudgePort {
  calls = 0

  async consult(): Promise<Consultation> {
    this.calls += 1
    return {
      kind: EConsultation.Judged,
      verdict: { judgment: EJudgment.Check, reason: CHECKED },
      elapsedMs: 12,
    }
  }
}

const reasonOf = (outcome: { decision: EBeforeToolDecision }): string =>
  'reason' in outcome && typeof outcome.reason === 'string' ? outcome.reason : ''

describe('a classifier chain built before the judge was bound', () => {
  it('refuses on a judge registered after the hook was constructed', async () => {
    const chain = chainWith({ mode: EClassifierMode.Nudge })
    const judge = new CheckingJudge()

    chain.bind(judge)
    const outcome = await chain.weigh()

    expect(outcome.decision).toBe(EBeforeToolDecision.Deny)
    expect(reasonOf(outcome)).toContain('uncommitted work')
    expect(judge.calls).toBe(1)
    expect(judgedIn(outcome).consulted).toBe(true)
  })

  it('follows the judge that arrives, on the very instance that ran without one', async () => {
    const chain = chainWith({ mode: EClassifierMode.Nudge })

    const disarmed = await chain.weigh()
    chain.bind(new CheckingJudge())
    const armed = await chain.weigh()

    expect(disarmed.decision).toBe(EBeforeToolDecision.Allow)
    expect(armed.decision).toBe(EBeforeToolDecision.Deny)
  })

  it('records the demotion in the row it writes, rather than looking like plain shadow', async () => {
    const judged = judgedIn(await chainWith({ mode: EClassifierMode.Nudge }).weigh())

    expect(judged.mode).toBe(EClassifierMode.Shadow)
    expect(judged.consulted).toBe(false)
    expect(judged.reason).toContain('no judge')
  })

  it('warns the operator that the mode they set cannot be honoured', async () => {
    const chain = chainWith({ mode: EClassifierMode.Nudge })

    await chain.weigh()

    expect(chain.mishaps.map((mishap) => mishap.label)).toEqual(['classifyCall'])
    expect(chain.mishaps[0]?.detail).toContain('nudge')
  })

  it('warns once, not on every candidate call', async () => {
    const chain = chainWith({ mode: EClassifierMode.Nudge })

    await chain.weigh()
    await chain.weigh()
    await chain.weigh()

    expect(chain.mishaps).toHaveLength(1)
  })

  it('says nothing when the operator asked for shadow, because nothing was taken away', async () => {
    const chain = chainWith({ mode: EClassifierMode.Shadow })

    const outcome = await chain.weigh()

    expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
    expect(chain.mishaps).toEqual([])
  })

  it('stops complaining once a judge answers, so the notice tracks the present', async () => {
    const chain = chainWith({ mode: EClassifierMode.Nudge })

    await chain.weigh()
    chain.bind(new CheckingJudge())
    const armed = await chain.weigh()

    expect(chain.mishaps).toHaveLength(1)
    expect(judgedIn(armed).mode).toBe(EClassifierMode.Nudge)
  })
})
