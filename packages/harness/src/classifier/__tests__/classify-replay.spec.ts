import { describe, expect, it } from 'bun:test'

import {
  DEFAULT_CLASSIFIER_POLICY,
  EClassifierMode,
  EConsultation,
  EJudgment,
  ETriage,
  EUndoing,
  toCallId,
  toThreadId,
  type CallEvidence,
  type Consultation,
  type Event,
  type RiskSignal,
} from '@dltech/atlas-core'

import { replayThread, type ReplayReport } from '../replay'
import { summarise } from '../replay-summary'
import { factsInAWorktree, OURS, RecordingFacts, REPO, stamped, TOOLS } from './fixtures'

const THREAD = toThreadId('thread-1')

const POLICY = { ...DEFAULT_CLASSIFIER_POLICY, mode: EClassifierMode.Nudge }

const recordedThread = (): readonly Event[] =>
  stamped([
    { type: 'user-said', text: 'tidy the worktree up' },
    {
      type: 'tool-called',
      callId: toCallId('call-edit'),
      name: 'edit',
      input: { path: `${OURS}/src/a.ts`, text: 'x' },
      ordinal: 0,
    },
    { type: 'tool-result', callId: toCallId('call-edit'), name: 'edit', output: 'ok' },
    {
      type: 'tool-called',
      callId: toCallId('call-test'),
      name: 'bash',
      input: { command: 'bun test' },
      ordinal: 1,
    },
    { type: 'tool-result', callId: toCallId('call-test'), name: 'bash', output: 'ok' },
    {
      type: 'tool-called',
      callId: toCallId('call-reset'),
      name: 'bash',
      input: { command: 'git reset --hard HEAD' },
      ordinal: 2,
    },
    { type: 'tool-result', callId: toCallId('call-reset'), name: 'bash', output: 'ok' },
    { type: 'user-said', text: 'undo that, it was the wrong worktree' },
  ])

class CountingJudge {
  readonly briefs: CallEvidence[] = []

  constructor(private readonly answer: Consultation) {}

  async consult({
    evidence,
  }: {
    evidence: CallEvidence
    standing: readonly RiskSignal[]
    events: readonly Event[]
    signal: AbortSignal
  }): Promise<Consultation> {
    this.briefs.push(evidence)
    return this.answer
  }
}

const replay = (judge?: CountingJudge): Promise<ReplayReport> =>
  replayThread({
    events: recordedThread(),
    threadId: THREAD,
    projectDirectory: OURS,
    launchDirectory: REPO,
    tools: TOOLS,
    facts: new RecordingFacts(factsInAWorktree()),
    policy: POLICY,
    ...(judge === undefined ? {} : { judge }),
  })

describe('replaying a recorded thread with the current code', () => {
  it('weighs only what phase A could not clear, and writes no row for the rest', async () => {
    const report = await replay()

    expect(report.rows.map((row) => row.toolName)).toEqual(['edit', 'bash', 'bash'])
    expect(report.rows.map((row) => row.judged === undefined)).toEqual([true, true, false])
    expect(report.rows[2]?.judged?.triage).toBe(ETriage.Consult)
  })

  it('counts candidates, turns and pauses the way the sidebar figure would', async () => {
    const summary = summarise({ report: await replay() })

    expect(summary.calls).toBe(3)
    expect(summary.turns).toBe(2)
    expect(summary.clearedByShape).toBe(2)
    expect(summary.weighed).toBe(1)
    expect(summary.asks).toBe(1)
    expect(summary.asksPerTurn).toBe(0.5)
    expect(summary.askedThen).toBe(0)
  })

  it('groups the pauses it would cause by dimension', async () => {
    const summary = summarise({ report: await replay() })

    expect(summary.pausesByDimension.map((entry) => entry.count)).toEqual([1])
    expect(summary.signalsByDimension.length).toBeGreaterThan(0)
  })

  it('touches no judge at all, so the run is free', async () => {
    const summary = summarise({ report: await replay() })

    expect(summary.consulted).toBe(0)
    expect(summary.budgeted).toBe(0)
    expect(summary.unreachable).toBe(0)
  })
})

describe('the judge the replay only reaches when it is asked to', () => {
  it('is consulted once per surviving candidate and never for a phase A clear', async () => {
    const judge = new CountingJudge({
      kind: EConsultation.Judged,
      verdict: { judgment: EJudgment.Proceed, reason: '' },
      elapsedMs: 1,
    })

    const summary = summarise({ report: await replay(judge) })

    expect(judge.briefs.length).toBe(1)
    expect(judge.briefs[0]?.toolName).toBe('bash')
    expect(summary.consulted).toBe(1)
    expect(summary.asks).toBe(0)
  })
})

describe('the misses, which are a heuristic and not a measurement', () => {
  it('flags a call that cleared and was then thrown away by a later reset', async () => {
    const report = await replay()
    const summary = summarise({ report })

    expect(summary.suspectedMisses).toBe(1)
    expect(report.rows[0]?.undone?.kind).toBe(EUndoing.WorkDiscarded)
    expect(report.rows[1]?.undone).toBeUndefined()
  })
})
