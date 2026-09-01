import { describe, expect, it } from 'bun:test'

import {
  DEFAULT_CLASSIFIER_POLICY,
  deedsOf,
  EConsultation,
  EGrantScope,
  EJudgment,
  EMessageOrigin,
  EPathDeclaration,
  ERiskDimension,
  ESeverity,
  EToolEffect,
  JudgePort,
  NO_FACTS,
  readCommand,
  toCallId,
  toEventId,
  toRunId,
  toThreadId,
  type Brief,
  type CallEvidence,
  type Consultation,
  type Event,
  type Grant,
  type RiskSignal,
  type ToolCall,
} from '@dltech/atlas-core'

import { JudgeMemo, JUDGE_CALLS_PER_TURN, memoKeyOf, turnKeyOf } from '../judge-memo'

const THREAD = toThreadId('thread-1')

const PROCEEDING: Consultation = {
  kind: EConsultation.Judged,
  verdict: { judgment: EJudgment.Proceed, reason: '' },
  elapsedMs: 400,
}

class CountingJudge extends JudgePort {
  readonly briefs: Brief[] = []

  async consult({ brief }: { brief: Brief; signal: AbortSignal }): Promise<Consultation> {
    this.briefs.push(brief)
    return PROCEEDING
  }
}

const signalAt = (args: { severity: ESeverity; subject?: string | undefined }): RiskSignal => ({
  dimension: ERiskDimension.Irreversibility,
  severity: args.severity,
  id: `probe:${args.severity}`,
  subject: args.subject ?? 'path:/repo/src',
  detail: 'a detail line',
  ungrantable: false,
})

const evidenceFor = (args: {
  command: string
  grants?: readonly Grant[] | undefined
}): CallEvidence => {
  const reading = readCommand({
    command: args.command,
    workdir: undefined,
    projectDirectory: '/repo',
  })
  const call: ToolCall = {
    callId: toCallId('call-1'),
    name: 'bash',
    input: { command: args.command },
    effect: EToolEffect.Destructive,
    threadId: THREAD,
  }

  return {
    deeds: deedsOf({
      call,
      declaration: { kind: EPathDeclaration.Declared, fields: [] },
      reading,
      projectDirectory: '/repo',
    }),
    toolName: 'bash',
    effect: EToolEffect.Destructive,
    threadId: THREAD,
    reading,
    facts: NO_FACTS,
    recent: [],
    said: [],
    grants: args.grants ?? [],
  }
}

const said = (args: { seq: number; text: string }): Event => ({
  id: toEventId(`event-${args.seq}`),
  seq: args.seq,
  threadId: THREAD,
  runId: toRunId('run-1'),
  depth: 0,
  at: '2026-01-01T00:00:00.000Z',
  type: 'user-said',
  text: args.text,
  via: EMessageOrigin.Operator,
})

const TURN_ONE: readonly Event[] = [said({ seq: 1, text: 'clean up the worktrees' })]
const TURN_TWO: readonly Event[] = [...TURN_ONE, said({ seq: 9, text: 'now do the other one' })]

const memoOver = (args: { judge: JudgePort; callsPerTurn?: number | undefined }) =>
  new JudgeMemo({
    judge: args.judge,
    policy: () => DEFAULT_CLASSIFIER_POLICY,
    ...(args.callsPerTurn === undefined ? {} : { callsPerTurn: args.callsPerTurn }),
  })

const consultOver = async (args: {
  memo: JudgeMemo
  command: string
  standing: readonly RiskSignal[]
  events?: readonly Event[] | undefined
}): Promise<Consultation> =>
  args.memo.consult({
    evidence: evidenceFor({ command: args.command }),
    standing: args.standing,
    events: args.events ?? TURN_ONE,
    signal: new AbortController().signal,
  })

const SERIOUS = [signalAt({ severity: ESeverity.Serious })]
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
