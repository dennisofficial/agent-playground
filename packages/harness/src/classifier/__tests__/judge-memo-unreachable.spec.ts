import { describe, expect, it } from 'bun:test'

import { EConsultation, JudgePort, type Consultation } from '@dltech/atlas-core'

import { consultOver, memoOver, PROCEEDING, SERIOUS } from './judge-memo-kit'

const UNREACHED: Consultation = { kind: EConsultation.Unreachable, fault: 'fetch failed' }

class BlinkingJudge extends JudgePort {
  calls = 0

  constructor(private readonly blips: number) {
    super()
  }

  async consult(): Promise<Consultation> {
    this.calls += 1
    return this.calls <= this.blips ? UNREACHED : PROCEEDING
  }
}

describe('JudgeMemo when the judge cannot be reached', () => {
  it('asks again after a blip instead of holding the failure for the rest of the turn', async () => {
    const judge = new BlinkingJudge(1)
    const memo = memoOver({ judge })

    const first = await consultOver({ memo, command: 'rm -rf /repo/dist', standing: SERIOUS })
    const second = await consultOver({ memo, command: 'rm -rf /repo/dist', standing: SERIOUS })

    expect(first.kind).toBe(EConsultation.Unreachable)
    expect(second.kind).toBe(EConsultation.Judged)
    expect(judge.calls).toBe(2)
  })

  it('holds the verdict once one arrives, so the retry costs a single call', async () => {
    const judge = new BlinkingJudge(1)
    const memo = memoOver({ judge })

    await consultOver({ memo, command: 'rm -rf /repo/dist', standing: SERIOUS })
    await consultOver({ memo, command: 'rm -rf /repo/dist', standing: SERIOUS })
    await consultOver({ memo, command: 'rm -rf /repo/dist', standing: SERIOUS })

    expect(judge.calls).toBe(2)
  })

  it('spends a call from the turn budget on every attempt it makes', async () => {
    const judge = new BlinkingJudge(Number.MAX_SAFE_INTEGER)
    const memo = memoOver({ judge, callsPerTurn: 2 })

    await consultOver({ memo, command: 'rm -rf /repo/dist', standing: SERIOUS })
    await consultOver({ memo, command: 'rm -rf /repo/dist', standing: SERIOUS })
    const third = await consultOver({ memo, command: 'rm -rf /repo/dist', standing: SERIOUS })

    expect(judge.calls).toBe(2)
    expect(third.kind).toBe(EConsultation.Budgeted)
  })
})
