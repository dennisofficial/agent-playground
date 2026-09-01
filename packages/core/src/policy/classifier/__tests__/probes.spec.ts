import { describe, expect, it } from 'bun:test'

import { ERiskDimension, ESeverity } from '../dimension'
import type { CallEvidence } from '../evidence'
import { EOccupancy } from '../facts'
import { contentionProbe } from '../probes/contention'
import { irreversibilityProbe } from '../probes/irreversibility'
import { reachProbe } from '../probes/reach'
import { signalsFor, type RiskSignal, type SignalProbe } from '../signals'
import { OURS, REPO, SIBLING, bashEvidence, inAWorktree, onMain, writeEvidence } from './fixtures'

const from = (probe: SignalProbe, evidence: CallEvidence): readonly RiskSignal[] =>
  signalsFor({ evidence, probes: [probe] })

const severities = (signals: readonly RiskSignal[]): readonly ESeverity[] =>
  signals.map((signal) => signal.severity)

const worst = (signals: readonly RiskSignal[]): ESeverity | undefined =>
  signals.find((signal) => signal.severity === ESeverity.Grave)?.severity ??
  signals.find((signal) => signal.severity === ESeverity.Serious)?.severity ??
  signals[0]?.severity

describe('the irreversibility probe', () => {
  it('records a pathspec-scoped discard as a note', () => {
    const signals = from(
      irreversibilityProbe,
      bashEvidence({ command: 'git checkout -- packages/core/src/foo.ts', facts: onMain() }),
    )

    expect(severities(signals)).toEqual([ESeverity.Note])
  })

  it('rates a tree-wide discard over a dirty checkout grave', () => {
    const signals = from(
      irreversibilityProbe,
      bashEvidence({ command: 'git checkout -- .', facts: onMain() }),
    )

    expect(worst(signals)).toBe(ESeverity.Grave)
  })

  it('stays silent on a tree-wide discard when the tree has nothing uncommitted', () => {
    const signals = from(
      irreversibilityProbe,
      bashEvidence({ command: 'git reset --hard', facts: onMain({ changedCount: 0 }) }),
    )

    expect(signals).toEqual([])
  })

  it('rates a removal outside the project serious and one inside it a note', () => {
    expect(
      severities(
        from(irreversibilityProbe, bashEvidence({ command: 'rm -rf ~/.atlas', facts: onMain() })),
      ),
    ).toEqual([ESeverity.Serious])
    expect(
      severities(
        from(
          irreversibilityProbe,
          bashEvidence({ command: 'rm docs/architecture.md', facts: onMain() }),
        ),
      ),
    ).toEqual([ESeverity.Note])
  })

  it('rates a stash mutation serious, because every worktree shares the stack', () => {
    const signals = from(
      irreversibilityProbe,
      bashEvidence({ command: 'git stash pop', facts: onMain() }),
    )

    expect(severities(signals)).toEqual([ESeverity.Serious])
  })

  it('rates dropping the reflog grave', () => {
    const signals = from(
      irreversibilityProbe,
      bashEvidence({ command: 'git reflog expire --expire=now --all', facts: onMain() }),
    )

    expect(worst(signals)).toBe(ESeverity.Grave)
  })
})

describe('the reach probe', () => {
  it('says nothing about a mutation inside the project directory', () => {
    expect(
      from(reachProbe, bashEvidence({ command: 'rm -rf apps/tui/dist', facts: onMain() })),
    ).toEqual([])
  })

  it('records an additive write into another worktree as a note', () => {
    const signals = from(
      reachProbe,
      writeEvidence({ path: `${SIBLING}/notes.md`, facts: inAWorktree() }),
    )

    expect(severities(signals)).toEqual([ESeverity.Note])
    expect(signals[0]?.subject).toBe('worktree:eng-412-sidebar')
  })

  it('rates a destructive reach into the main checkout serious', () => {
    const signals = from(
      reachProbe,
      bashEvidence({ command: `rm -rf ${REPO}/docs`, facts: inAWorktree() }),
    )

    expect(severities(signals)).toEqual([ESeverity.Serious])
  })

  it('exempts creating a worktree, the mechanism the whole feature protects', () => {
    const evidence = bashEvidence({
      command: `git worktree add ${REPO}/.claude/worktrees/new -b new origin/main`,
      facts: inAWorktree(),
    })

    expect(from(reachProbe, evidence)).toEqual([])
  })
})

describe('the contention probe', () => {
  it('rates a mutation of a dirty worktree that is not ours grave and ungrantable', () => {
    const signals = from(
      contentionProbe,
      bashEvidence({
        command: 'rm -rf ../eng-412-sidebar',
        facts: inAWorktree({ siblingChangedCount: 12 }),
      }),
    )

    expect(severities(signals)).toEqual([ESeverity.Grave])
    expect(signals[0]?.ungrantable).toBe(true)
    expect(signals[0]?.detail).toContain('12 uncommitted')
  })

  it('names a live holder in the detail rather than needing one to fire', () => {
    const signals = from(
      contentionProbe,
      bashEvidence({
        command: 'rm -rf ../eng-412-sidebar',
        facts: inAWorktree({
          siblingChangedCount: 3,
          siblingOccupancy: EOccupancy.LiveOther,
          siblingHeldBy: 4142,
        }),
      }),
    )

    expect(signals[0]?.detail).toContain('4142')
  })

  it('rates a live but clean worktree grave, and leaves it grantable', () => {
    const signals = from(
      contentionProbe,
      bashEvidence({
        command: 'rm -rf ../eng-412-sidebar',
        facts: inAWorktree({ siblingChangedCount: 0, siblingOccupancy: EOccupancy.LiveOther }),
      }),
    )

    expect(severities(signals)).toEqual([ESeverity.Grave])
    expect(signals[0]?.ungrantable).toBe(false)
  })

  it('says nothing about our own worktree, however dirty it is', () => {
    expect(
      from(contentionProbe, bashEvidence({ command: 'git reset --hard', facts: onMain() })),
    ).toEqual([])
  })

  it('rates deleting a branch checked out elsewhere grave', () => {
    const facts = inAWorktree({
      refs: [{ ref: 'dennis/eng-412-sidebar', onRemote: false, checkedOutAt: [SIBLING] }],
    })
    const signals = from(
      contentionProbe,
      bashEvidence({ command: 'git branch -D dennis/eng-412-sidebar', facts }),
    )

    expect(severities(signals)).toEqual([ESeverity.Grave])
  })
})

describe('a probe that throws', () => {
  it('yields no signals rather than failing the call', () => {
    const broken: SignalProbe = {
      dimension: ERiskDimension.Blast,
      probe: () => {
        throw new Error('probe is broken')
      },
    }

    expect(
      signalsFor({
        evidence: bashEvidence({ command: 'git status', facts: onMain() }),
        probes: [broken],
      }),
    ).toEqual([])
  })
})
