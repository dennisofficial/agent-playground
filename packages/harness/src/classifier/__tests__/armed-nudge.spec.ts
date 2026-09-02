import { describe, expect, it } from 'bun:test'

import {
  DEFAULT_CLASSIFIER_POLICY,
  EBeforeToolDecision,
  EClassifierMode,
  EConsultation,
  EDecision,
  EJudgment,
  ERiskDimension,
  toCallId,
} from '@dltech/atlas-core'

import {
  callTo,
  classify,
  factsInAWorktree,
  hookOver,
  judgedIn,
  policyIn,
  RecordingFacts,
  SIBLING,
  stamped,
} from './fixtures'

describe('the same call once the nudge is armed', () => {
  const REMOVAL = `git worktree remove --force ${SIBLING}`

  const CHECKED = `contention: ${SIBLING} carries uncommitted work that would go with it`

  const armed = (over: Partial<Parameters<typeof hookOver>[0]> = {}) =>
    hookOver({
      facts: new RecordingFacts(factsInAWorktree({ siblingChangedCount: 12 })),
      policy: policyIn(EClassifierMode.Nudge),
      judge: {
        consult: async () => ({
          kind: EConsultation.Judged,
          verdict: { judgment: EJudgment.Check, reason: CHECKED },
          elapsedMs: 12,
        }),
      },
      ...over,
    })

  it('refuses with a reason naming the worktree and what would be lost', async () => {
    const outcome = await classify({
      hook: armed(),
      call: callTo({ name: 'bash', input: { command: REMOVAL } }),
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Deny)
    expect(outcome.decision === EBeforeToolDecision.Deny ? outcome.reason : '').toContain(SIBLING)
    expect(outcome.decision === EBeforeToolDecision.Deny ? outcome.reason : '').toContain(
      'uncommitted work',
    )
  })

  it('hands the drawer the probes own words alongside the judges', async () => {
    const judged = judgedIn(
      await classify({
        hook: armed(),
        call: callTo({ name: 'bash', input: { command: REMOVAL } }),
      }),
    )

    expect(judged.wouldAsk).toBe(true)
    expect(judged.judgedDimension).toBe(ERiskDimension.Contention)
    expect(judged.details?.join(' ')).toContain(SIBLING)
  })

  it('lets the same call through once the operator has already allowed it', async () => {
    const events = stamped([
      {
        type: 'tool-called',
        callId: toCallId('call-1'),
        name: 'bash',
        input: { command: REMOVAL },
        ordinal: 0,
      },
      { type: 'approval-requested', callId: toCallId('call-1'), reason: CHECKED },
      { type: 'approval-answered', callId: toCallId('call-1'), decision: EDecision.Allow },
    ])

    const outcome = await classify({
      hook: armed(),
      call: callTo({ name: 'bash', input: { command: REMOVAL } }),
      events,
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
    expect(outcome.drafts ?? []).toEqual([])
  })

  it('goes quiet after the thread has spent its interruptions', async () => {
    const spent = Array.from({ length: DEFAULT_CLASSIFIER_POLICY.asksPerThread }, (_, index) => ({
      type: 'approval-requested' as const,
      callId: toCallId(`spent-${String(index)}`),
      reason: 'asked already',
    }))

    const outcome = await classify({
      hook: armed(),
      call: callTo({ name: 'bash', input: { command: REMOVAL } }),
      events: stamped(spent),
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
    expect(judgedIn(outcome).fatigued).toBe(true)
    expect(judgedIn(outcome).wouldAsk).toBe(false)
  })

  it('refuses anyway when the judge cannot be reached and the signal is grave', async () => {
    const outcome = await classify({
      hook: armed({
        judge: {
          consult: async () => ({ kind: EConsultation.Unreachable, fault: 'fetch failed' }),
        },
      }),
      call: callTo({ name: 'bash', input: { command: `rm -rf ${SIBLING}` } }),
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Deny)
    expect(outcome.decision === EBeforeToolDecision.Deny ? outcome.reason : '').toContain(
      'could not check this',
    )
  })
})
