import { describe, expect, it } from 'bun:test'

import { ERiskDimension, ESeverity } from '../dimension'
import { EGrantScope, grantCovering, type Grant } from '../grant'
import { signalsFor, type RiskSignal } from '../signals'
import {
  DEFAULT_CLASSIFIER_POLICY,
  EClassifierMode,
  ETriage,
  triageOf,
  type ClassifierPolicy,
} from '../triage'
import { SIBLING, bashEvidence, inAWorktree, onMain, triageFor } from './fixtures'

const signal = (args: {
  dimension?: ERiskDimension | undefined
  severity: ESeverity
  subject?: string | undefined
  ungrantable?: boolean | undefined
}): RiskSignal => ({
  dimension: args.dimension ?? ERiskDimension.Reach,
  severity: args.severity,
  id: 'test:signal',
  subject: args.subject ?? 'worktree:eng-412-sidebar',
  detail: 'a signal written by a test',
  ungrantable: args.ungrantable ?? false,  unverified: false,

})

const grant = (args: {
  dimensions?: readonly ERiskDimension[] | undefined
  subject?: string | undefined
}): Grant => ({
  grantId: 'grant-1',
  dimensions: args.dimensions ?? [ERiskDimension.Reach],
  scope: EGrantScope.Thread,
  subject: args.subject ?? 'worktree:eng-412-sidebar',
  reason: 'the operator said to stop asking about this worktree',
  seq: 7,
})

const triage = (args: {
  signals: readonly RiskSignal[]
  grants?: readonly Grant[] | undefined
  policy?: Partial<ClassifierPolicy> | undefined
  asksSoFar?: number | undefined
}) =>
  triageOf({
    evidence: {
      ...bashEvidence({ command: 'git status', facts: onMain() }),
      grants: args.grants ?? [],
    },
    signals: args.signals,
    policy: { ...DEFAULT_CLASSIFIER_POLICY, ...args.policy },
    asksSoFar: args.asksSoFar ?? 0,
  })

describe('the severity floor', () => {
  it('drops a signal below consultAtOrAbove and clears the call', () => {
    const decided = triage({ signals: [signal({ severity: ESeverity.Note })] })

    expect(decided.triage).toBe(ETriage.Clear)
    expect(decided.standing).toEqual([])
  })

  it('consults on a signal that reaches the floor', () => {
    expect(triage({ signals: [signal({ severity: ESeverity.Serious })] }).triage).toBe(
      ETriage.Consult,
    )
  })

  it('honours a raised floor', () => {
    const decided = triage({
      signals: [signal({ severity: ESeverity.Serious })],
      policy: { consultAtOrAbove: ESeverity.Grave },
    })

    expect(decided.triage).toBe(ETriage.Clear)
  })
})

describe('a muted dimension', () => {
  it('drops every signal of that dimension', () => {
    const decided = triage({
      signals: [signal({ severity: ESeverity.Grave, dimension: ERiskDimension.Reach })],
      policy: { muted: [ERiskDimension.Reach] },
    })

    expect(decided.triage).toBe(ETriage.Clear)
    expect(decided.standing).toEqual([])
  })
})

describe('a standing grant', () => {
  it('clears a grantable signal whose subject and dimension it names', () => {
    const covered = signal({ severity: ESeverity.Grave })
    const decided = triage({ signals: [covered], grants: [grant({})] })

    expect(decided.triage).toBe(ETriage.Clear)
    expect(decided.cleared).toEqual([{ signal: covered, by: grant({}) }])
  })

  it('never clears an ungrantable signal, whatever it names', () => {
    const covered = signal({ severity: ESeverity.Grave, ungrantable: true })
    const decided = triage({ signals: [covered], grants: [grant({})] })

    expect(decided.triage).toBe(ETriage.Consult)
    expect(decided.standing).toEqual([covered])
    expect(decided.cleared).toEqual([])
  })

  it('refuses an ungrantable signal before it ever matches a subject', () => {
    const wide = grant({
      subject: 'worktree:eng-412-sidebar',
      dimensions: [ERiskDimension.Contention],
    })
    const covered = signal({
      severity: ESeverity.Grave,
      dimension: ERiskDimension.Contention,
      ungrantable: true,
    })

    expect(grantCovering({ signal: covered, grants: [wide] })).toBeUndefined()
  })

  it('does not clear a signal about another subject', () => {
    const covered = signal({ severity: ESeverity.Grave, subject: 'worktree:eng-500-other' })

    expect(triage({ signals: [covered], grants: [grant({})] }).triage).toBe(ETriage.Consult)
  })

  it('does not clear a signal of a dimension it does not name', () => {
    const covered = signal({ severity: ESeverity.Grave, dimension: ERiskDimension.Blast })

    expect(triage({ signals: [covered], grants: [grant({})] }).triage).toBe(ETriage.Consult)
  })
})

describe('the fatigue cap', () => {
  it('clears everything once the thread has spent its asks, and says so', () => {
    const decided = triage({ signals: [signal({ severity: ESeverity.Grave })], asksSoFar: 8 })

    expect(decided.triage).toBe(ETriage.Clear)
    expect(decided.fatigued).toBe(true)
    expect(decided.standing).toHaveLength(1)
  })

  it('is not fatigued when nothing was standing in the first place', () => {
    expect(triage({ signals: [], asksSoFar: 40 }).fatigued).toBe(false)
  })

  it('goes quiet even about a grave signal no grant could ever cover', () => {
    const decided = triage({
      signals: [signal({ severity: ESeverity.Grave, ungrantable: true })],
      asksSoFar: DEFAULT_CLASSIFIER_POLICY.asksPerThread,
    })

    expect(decided.triage).toBe(ETriage.Clear)
    expect(decided.fatigued).toBe(true)
  })

  it('still consults on the ask that brings the thread level with the cap', () => {
    const decided = triage({
      signals: [signal({ severity: ESeverity.Grave })],
      asksSoFar: DEFAULT_CLASSIFIER_POLICY.asksPerThread - 1,
    })

    expect(decided.triage).toBe(ETriage.Consult)
    expect(decided.fatigued).toBe(false)
  })
})

describe('a grant on the incident this feature exists for', () => {
  it('cannot buy clearance over a dirty sibling worktree', () => {
    const evidence = {
      ...bashEvidence({
        command: 'rm -rf ../eng-412-sidebar',
        facts: inAWorktree({ siblingChangedCount: 12 }),
      }),
      grants: [
        grant({
          dimensions: [
            ERiskDimension.Contention,
            ERiskDimension.Reach,
            ERiskDimension.Irreversibility,
          ],
          subject: 'worktree:eng-412-sidebar',
        }),
      ],
    }

    const decided = triageOf({
      evidence,
      signals: signalsFor({ evidence }),
      policy: DEFAULT_CLASSIFIER_POLICY,
      asksSoFar: 0,
    })

    expect(decided.triage).toBe(ETriage.Consult)
    expect(decided.standing.some((standing) => standing.ungrantable)).toBe(true)
  })
})

describe('every enumerated combination', () => {
  it('yields only clear or consult, never an ask', () => {
    const modes = [EClassifierMode.Off, EClassifierMode.Shadow, EClassifierMode.Nudge]
    const severities = [ESeverity.Note, ESeverity.Serious, ESeverity.Grave]
    const dimensions = Object.values(ERiskDimension)

    for (const mode of modes) {
      for (const severity of severities) {
        for (const dimension of dimensions) {
          for (const ungrantable of [false, true]) {
            for (const asksSoFar of [0, 99]) {
              for (const grants of [[], [grant({ dimensions })]]) {
                const decided = triage({
                  signals: [signal({ severity, dimension, ungrantable })],
                  grants,
                  policy: { mode },
                  asksSoFar,
                })

                expect([ETriage.Clear, ETriage.Consult]).toContain(decided.triage)
              }
            }
          }
        }
      }
    }
  })
})

describe('the shape a benign call leaves behind', () => {
  it('records nothing standing for a read of another worktree', () => {
    const decided = triageFor({
      evidence: bashEvidence({
        command: `cat ${SIBLING}/CLAUDE.md`,
        facts: inAWorktree({ siblingChangedCount: 12 }),
      }),
    })

    expect(decided).toEqual({
      triage: ETriage.Clear,
      standing: [],
      cleared: [],
      fatigued: false,
    })
  })
})
