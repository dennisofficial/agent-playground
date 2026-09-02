import { describe, expect, it } from 'bun:test'

import { toEventId, toRunId, toThreadId } from '../../../events/ids'
import { stampDrafts } from '../../../events/stamp'
import type { EventDraft } from '../../../events/body'
import type { Event } from '../../../events/envelope'
import { ERiskDimension } from '../dimension'
import {
  EGrantScope,
  grantCovering,
  grantOffersOf,
  grantsFrom,
  type Grant,
  type GrantOffer,
} from '../grant'
import { signalsFor, type RiskSignal } from '../signals'
import { ETriage } from '../triage'
import { bashEvidence, inAWorktree, OURS, REPO, SIBLING, triageFor } from './fixtures'

const standingFor = (args: {
  command: string
  siblingChangedCount?: number | undefined
  mainChangedCount?: number | undefined
  grants?: readonly Grant[] | undefined
}): readonly RiskSignal[] =>
  triageFor({
    evidence: bashEvidence({
      command: args.command,
      workdir: OURS,
      facts: inAWorktree({
        siblingChangedCount: args.siblingChangedCount ?? 0,
        mainChangedCount: args.mainChangedCount ?? 0,
      }),
      grants: args.grants,
    }),
  }).standing

const offersFor = (args: { command: string; siblingChangedCount?: number | undefined }) =>
  grantOffersOf({ signals: standingFor(args) })

const mint = (offers: readonly GrantOffer[]): readonly Grant[] =>
  offers.map((offer, index) => ({
    grantId: `grant-${String(index + 1)}`,
    dimensions: offer.dimensions,
    scope: EGrantScope.Thread,
    subject: offer.subject,
    reason: 'the operator chose to stop being asked about this',
    seq: index + 1,
  }))

const subjectsOf = (offers: readonly GrantOffer[]): readonly string[] =>
  offers.map((offer) => offer.subject)

const REMOVE_A_SIBLING = `rm -rf ${SIBLING}`

const REMOVE_MAIN_NODE_MODULES = `rm -rf ${REPO}/node_modules`

describe('the subject a grant is derived on', () => {
  it('names the worktree the call actually reached into, never the repository above it', () => {
    const subjects = subjectsOf(offersFor({ command: REMOVE_A_SIBLING }))

    expect(subjects).toContain('worktree:eng-412-sidebar')
    expect(subjects).not.toContain('worktree:atlas')
    expect(subjects).not.toContain(`path:${REPO}`)
  })

  it('names the directory the call actually named, never its parent', () => {
    const subjects = subjectsOf(offersFor({ command: REMOVE_MAIN_NODE_MODULES }))

    expect(subjects).toContain(`path:${REPO}/node_modules`)
    expect(subjects.some((subject) => subject === `path:${REPO}`)).toBe(false)
  })

  it('gathers every dimension that fired on one subject into a single offer', () => {
    const offer = offersFor({ command: REMOVE_A_SIBLING }).find(
      (candidate) => candidate.subject === `path:${SIBLING}`,
    )

    expect(offer?.dimensions).toEqual([ERiskDimension.Irreversibility, ERiskDimension.Blast])
  })
})

describe('the incident this feature exists for', () => {
  it('does not let a grant on node_modules clear a later wipe of a sibling worktree', () => {
    const granted = mint(offersFor({ command: REMOVE_MAIN_NODE_MODULES }))
    expect(granted.length).toBeGreaterThan(0)

    const later = standingFor({ command: REMOVE_A_SIBLING, grants: granted })

    expect(later.map((signal) => signal.id)).toContain('blast:removes-a-whole-tree')
  })

  it('still silences the call it was actually given for', () => {
    const granted = mint(offersFor({ command: REMOVE_MAIN_NODE_MODULES }))

    const again = triageFor({
      evidence: bashEvidence({
        command: REMOVE_MAIN_NODE_MODULES,
        workdir: OURS,
        facts: inAWorktree({ mainChangedCount: 0 }),
        grants: granted,
      }),
    })

    expect(again.triage).toBe(ETriage.Clear)
    expect(again.standing).toEqual([])
    expect(again.cleared.length).toBe(granted.length)
  })

  it('withdraws the whole offer once a dirty sibling makes one signal unwaivable', () => {
    const offers = offersFor({ command: REMOVE_A_SIBLING, siblingChangedCount: 12 })
    const standing = standingFor({ command: REMOVE_A_SIBLING, siblingChangedCount: 12 })

    expect(standing.some((signal) => signal.ungrantable)).toBe(true)
    expect(offers).toEqual([])
  })
})

describe('the ungrantable floor', () => {
  it('turns away a grant of every dimension named on the signal itself', () => {
    const covered = standingFor({
      command: REMOVE_A_SIBLING,
      siblingChangedCount: 12,
    }).find((signal) => signal.ungrantable)

    if (covered === undefined) throw new Error('the dirty sibling raised no unwaivable signal')

    const everything: Grant = {
      grantId: 'grant-everything',
      dimensions: Object.values(ERiskDimension),
      scope: EGrantScope.Thread,
      subject: covered.subject,
      reason: 'allow everything',
      seq: 1,
    }

    expect(grantCovering({ signal: covered, grants: [everything] })).toBeUndefined()
  })

  it('leaves the operator nothing to press that the next call would ignore', () => {
    const dirty = { command: REMOVE_A_SIBLING, siblingChangedCount: 12 }
    const granted = mint(grantOffersOf({ signals: standingFor(dirty) }))

    expect(granted).toEqual([])
    expect(standingFor({ ...dirty, grants: granted }).length).toBeGreaterThan(0)
  })
})

describe('the offer the drawer is handed', () => {
  it('is empty when the probes raised nothing worth consulting about', () => {
    const evidence = bashEvidence({ command: 'ls', facts: inAWorktree() })

    expect(grantOffersOf({ signals: signalsFor({ evidence }) })).toEqual([])
  })
})

const logged = (drafts: readonly EventDraft[]): readonly Event[] =>
  stampDrafts({
    drafts,
    envelopes: drafts.map((_draft, index) => ({
      id: toEventId(`event-${String(index + 1)}`),
      seq: index + 1,
      threadId: toThreadId('thread-grants'),
      runId: toRunId('run-grants'),
      depth: 0,
      at: '2026-01-01T00:00:00.000Z',
    })),
  })

const grantedDrafts = (offers: readonly GrantOffer[]): readonly EventDraft[] =>
  offers.map((offer, index) => ({
    type: 'permission-granted',
    grantId: `grant-${String(index + 1)}`,
    dimensions: offer.dimensions,
    scope: EGrantScope.Thread,
    subject: offer.subject,
    reason: 'the operator chose to stop being asked about this',
  }))

describe('taking a grant back', () => {
  const offers = offersFor({ command: REMOVE_MAIN_NODE_MODULES })
  const given = grantedDrafts(offers)

  const triageWith = (drafts: readonly EventDraft[]) =>
    triageFor({
      evidence: bashEvidence({
        command: REMOVE_MAIN_NODE_MODULES,
        workdir: OURS,
        facts: inAWorktree({ mainChangedCount: 0 }),
        grants: grantsFrom(logged(drafts)),
      }),
    })

  it('reads the grant back out of the log and clears the call', () => {
    expect(triageWith(given).triage).toBe(ETriage.Clear)
  })

  it('re-arms the pause the moment the revocation lands', () => {
    const revoked: readonly EventDraft[] = given.map((draft) =>
      draft.type === 'permission-granted'
        ? { type: 'permission-revoked', grantId: draft.grantId }
        : draft,
    )

    expect(triageWith([...given, ...revoked]).triage).toBe(ETriage.Consult)
  })
})
