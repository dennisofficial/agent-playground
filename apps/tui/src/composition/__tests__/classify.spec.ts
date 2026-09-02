import { describe, expect, it } from 'bun:test'

import {
  EClassifierMode,
  EConsultation,
  EDeed,
  EJudgment,
  ERiskDimension,
  ETriage,
  EUndoing,
  toCallId,
  toThreadId,
} from '@dltech/atlas-core'
import { summarise, type ReplayReport, type ReplayRow } from '@dltech/atlas-harness'

import { classifyRequestOf, EClassifyTask } from '../classify'
import { replayLines } from '../classify-report'

const requestFor = (line: string) => classifyRequestOf({ argv: line.split(' ') })

describe('what the operator typed', () => {
  it('reads a replay of one recorded thread, offline by default', () => {
    expect(requestFor('classify --replay thread-7')).toEqual({
      task: EClassifyTask.Replay,
      threadId: 'thread-7',
      judge: false,
      capture: false,
      misses: false,
    })
  })

  it('reads the three things a replay can be asked to do as well', () => {
    expect(requestFor('classify --replay thread-7 --judge --capture --misses')).toEqual({
      task: EClassifyTask.Replay,
      threadId: 'thread-7',
      judge: true,
      capture: true,
      misses: true,
    })
  })

  it('reads a critique of the configuration', () => {
    expect(requestFor('classify --critique')).toEqual({ task: EClassifyTask.Critique })
  })

  it('complains when classify is given nothing to do', () => {
    expect(requestFor('classify')).toEqual({
      task: EClassifyTask.Usage,
      complaint: 'classify needs --replay or --critique',
    })
  })

  it('complains when --replay names no thread', () => {
    expect(requestFor('classify --replay --judge')).toEqual({
      task: EClassifyTask.Usage,
      complaint: '--replay needs the id of a recorded thread',
    })
  })

  it('answers --help without a complaint, and leaves an ordinary launch alone', () => {
    expect(requestFor('classify --help')).toEqual({
      task: EClassifyTask.Usage,
      complaint: undefined,
    })
    expect(requestFor('--resume thread-7')).toBeUndefined()
  })
})

const row = (over: Partial<ReplayRow> & { seq: number }): ReplayRow => ({
  callId: toCallId(`call-${over.seq}`),
  toolName: 'bash',
  deeds: [EDeed.Routine],
  evidence: undefined,
  judged: undefined,
  consultation: undefined,
  grantCleared: false,
  askedThen: false,
  undone: undefined,
  ...over,
})

const judged = (over: {
  triage: ETriage
  wouldAsk: boolean
  dimensions: readonly ERiskDimension[]
  judgedDimension?: ERiskDimension | undefined
}) => ({
  type: 'classifier-judged' as const,
  callId: toCallId('call-x'),
  mode: EClassifierMode.Nudge,
  triage: over.triage,
  judgment: over.wouldAsk ? EJudgment.Check : EJudgment.Proceed,
  dimensions: over.dimensions,
  ...(over.judgedDimension === undefined ? {} : { judgedDimension: over.judgedDimension }),
  signalIds: ['irreversibility:hard-reset'],
  reason: 'irreversibility on /repo would lose the uncommitted work',
  consulted: true,
  wouldAsk: over.wouldAsk,
  elapsedMs: 3,
})

const reportOf = (rows: readonly ReplayRow[]): ReplayReport => ({
  threadId: toThreadId('thread-7'),
  projectDirectory: '/repo',
  turns: 2,
  calls: rows.length,
  rows,
})

const linesFor = ({ rows, misses }: { rows: readonly ReplayRow[]; misses: boolean }) => {
  const report = reportOf(rows)
  return replayLines({ report, summary: summarise({ report }), misses })
}

describe('the table the replay prints', () => {
  const rows: readonly ReplayRow[] = [
    row({ seq: 2, toolName: 'edit', deeds: [EDeed.WriteFile] }),
    row({
      seq: 4,
      deeds: [EDeed.DiscardWorkingTree],
      judged: judged({
        triage: ETriage.Consult,
        wouldAsk: true,
        dimensions: [ERiskDimension.Irreversibility, ERiskDimension.Reach],
        judgedDimension: ERiskDimension.Irreversibility,
      }),
      consultation: EConsultation.Judged,
      askedThen: true,
    }),
    row({
      seq: 6,
      deeds: [EDeed.RemoveWorktree],
      judged: judged({ triage: ETriage.Clear, wouldAsk: false, dimensions: [] }),
      grantCleared: true,
    }),
  ]

  it('says how each call would have ended, phase A included', () => {
    const printed = linesFor({ rows, misses: false }).join('\n')

    expect(printed).toContain('clear (shape)')
    expect(printed).toContain('ASK')
    expect(printed).toContain('clear (granted)')
  })

  it('names the dimension the pause was actually about, not every signal that fired', () => {
    const printed = linesFor({ rows, misses: false })

    expect(printed.some((line) => line.includes(`ASK`) && line.includes('irreversibility'))).toBe(
      true,
    )
    expect(printed.some((line) => line.includes('ASK') && line.includes('reach'))).toBe(false)
    expect(printed).toContain('              irreversibility 1')
  })

  it('reports the pause rate against the turns the thread actually had', () => {
    expect(linesFor({ rows, misses: false })).toContain(
      'pauses        1 over 2 turns — 0.50 per turn',
    )
  })

  it('says the recorded run asked too, so the two can be compared', () => {
    const printed = linesFor({ rows, misses: false }).join('\n')

    expect(printed).toContain('recorded run  1 of these calls actually asked')
  })
})

describe('the misses column, which is a heuristic and says so', () => {
  const undone: readonly ReplayRow[] = [
    row({
      seq: 2,
      toolName: 'edit',
      deeds: [EDeed.WriteFile],
      undone: { kind: EUndoing.WorkDiscarded, seq: 9, detail: '/repo was reset after this call' },
    }),
  ]

  it('labels itself a heuristic whether or not the detail was asked for', () => {
    for (const misses of [true, false]) {
      expect(linesFor({ rows: undone, misses }).join('\n')).toContain('HEURISTIC')
    }
  })

  it('marks the row and counts it, and spells it out only when asked', () => {
    const quiet = linesFor({ rows: undone, misses: false }).join('\n')
    const spelled = linesFor({ rows: undone, misses: true }).join('\n')

    expect(quiet).toContain(EUndoing.WorkDiscarded)
    expect(quiet).toContain('misses        1 suspected')
    expect(quiet).not.toContain('/repo was reset after this call')
    expect(spelled).toContain('/repo was reset after this call')
  })

  it('says plainly when nothing was undone', () => {
    expect(linesFor({ rows: [row({ seq: 2 })], misses: true }).join('\n')).toContain(
      'no cleared call in this thread was visibly undone',
    )
  })
})
