import { describe, expect, it } from 'bun:test'

import {
  EConsultation,
  EGrantScope,
  ERiskDimension,
  ESeverity,
  JudgePort,
  type Brief,
  type Consultation,
  type Event,
  type Grant,
} from '@dltech/atlas-core'

import { JUDGE_CALLS_PER_TURN, memoKeyOf, turnKeyOf } from '../judge-memo'
import {
  consultOver,
  evidenceFor,
  memoOver,
  PROCEEDING,
  said,
  SERIOUS,
  signalAt,
  THREAD,
  TURN_ONE,
} from './judge-memo-kit'

class CountingJudge extends JudgePort {
  readonly briefs: Brief[] = []

  async consult({ brief }: { brief: Brief; signal: AbortSignal }): Promise<Consultation> {
    this.briefs.push(brief)
    return PROCEEDING
  }
}

const TURN_TWO: readonly Event[] = [...TURN_ONE, said({ seq: 9, text: 'now do the other one' })]

const GRAVE = [signalAt({ severity: ESeverity.Grave })]

describe('memoKeyOf', () => {
  it('is the same for the same deed, signals and grants', () => {
    const evidence = evidenceFor({ command: 'rm -rf /repo/dist' })

    expect(memoKeyOf({ evidence, standing: SERIOUS })).toBe(
      memoKeyOf({ evidence: evidenceFor({ command: 'rm -rf /repo/dist' }), standing: SERIOUS }),
    )
  })

  it('changes when the deed names a different target', () => {
    expect(
      memoKeyOf({ evidence: evidenceFor({ command: 'rm -rf /repo/dist' }), standing: SERIOUS }),
    ).not.toBe(
      memoKeyOf({ evidence: evidenceFor({ command: 'rm -rf /repo/build' }), standing: SERIOUS }),
    )
  })

  it('changes when a grant is minted, so a stale answer cannot outlive the permission', () => {
    const grant: Grant = {
      grantId: 'grant-1',
      dimensions: [ERiskDimension.Irreversibility],
      scope: EGrantScope.Thread,
      subject: 'path:/repo/dist',
      reason: 'the developer allowed it',
      seq: 4,
    }

    expect(
      memoKeyOf({ evidence: evidenceFor({ command: 'rm -rf /repo/dist' }), standing: SERIOUS }),
    ).not.toBe(
      memoKeyOf({
        evidence: evidenceFor({ command: 'rm -rf /repo/dist', grants: [grant] }),
        standing: SERIOUS,
      }),
    )
  })
})

describe('turnKeyOf', () => {
  it('changes when the developer speaks again', () => {
    expect(turnKeyOf({ events: TURN_ONE, threadId: THREAD })).not.toBe(
      turnKeyOf({ events: TURN_TWO, threadId: THREAD }),
    )
  })
})

describe('JudgeMemo', () => {
  it('consults once for the same call asked twice in a turn', async () => {
    const judge = new CountingJudge()
    const memo = memoOver({ judge })

    const first = await consultOver({ memo, command: 'rm -rf /repo/dist', standing: SERIOUS })
    const second = await consultOver({ memo, command: 'rm -rf /repo/dist', standing: SERIOUS })

    expect(judge.briefs.length).toBe(1)
    expect(second).toBe(first)
  })

  it('consults again for a different deed in the same turn', async () => {
    const judge = new CountingJudge()
    const memo = memoOver({ judge })

    await consultOver({ memo, command: 'rm -rf /repo/dist', standing: SERIOUS })
    await consultOver({ memo, command: 'rm -rf /repo/build', standing: SERIOUS })

    expect(judge.briefs.length).toBe(2)
  })

  it('forgets what it learned once the developer speaks again', async () => {
    const judge = new CountingJudge()
    const memo = memoOver({ judge })

    await consultOver({ memo, command: 'rm -rf /repo/dist', standing: SERIOUS })
    await consultOver({
      memo,
      command: 'rm -rf /repo/dist',
      standing: SERIOUS,
      events: TURN_TWO,
    })

    expect(judge.briefs.length).toBe(2)
  })

  it('hands the judge a brief built from the evidence, not a bare command', async () => {
    const judge = new CountingJudge()
    await consultOver({
      memo: memoOver({ judge }),
      command: 'rm -rf /repo/dist',
      standing: SERIOUS,
    })

    expect(judge.briefs[0]?.prompt).toContain('the call about to run')
    expect(judge.briefs[0]?.targets).toContain('/repo/src')
  })

  it('stops consulting on serious signals once the turn budget is spent', async () => {
    const judge = new CountingJudge()
    const memo = memoOver({ judge, callsPerTurn: 2 })

    await consultOver({ memo, command: 'rm -rf /repo/a', standing: SERIOUS })
    await consultOver({ memo, command: 'rm -rf /repo/b', standing: SERIOUS })
    const third = await consultOver({ memo, command: 'rm -rf /repo/c', standing: SERIOUS })

    expect(judge.briefs.length).toBe(2)
    expect(third.kind).toBe(EConsultation.Budgeted)
    expect(third.kind === EConsultation.Budgeted ? third.calls : 0).toBe(2)
  })

  it('still consults on a grave signal past the budget', async () => {
    const judge = new CountingJudge()
    const memo = memoOver({ judge, callsPerTurn: 2 })

    await consultOver({ memo, command: 'rm -rf /repo/a', standing: SERIOUS })
    await consultOver({ memo, command: 'rm -rf /repo/b', standing: SERIOUS })
    const third = await consultOver({ memo, command: 'rm -rf /repo/c', standing: GRAVE })

    expect(judge.briefs.length).toBe(3)
    expect(third.kind).toBe(EConsultation.Judged)
  })

  it('gives a turn six calls before it starts declining', () => {
    expect(JUDGE_CALLS_PER_TURN).toBe(6)
  })
})
