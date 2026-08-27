import { describe, expect, it } from 'bun:test'

import { EDecision, type EventDraft } from '../body'
import type { Event } from '../envelope'
import { EForkMode } from '../fork'
import { EForkRefusal, forkTarget } from '../fork-target'
import { toBranchId, toCallId, toEventId, toRunId } from '../ids'
import { stampDrafts } from '../stamp'

const stampedFrom = ({ drafts, firstSeq }: { drafts: readonly EventDraft[]; firstSeq: number }): Event[] =>
  stampDrafts({
    drafts,
    envelopes: drafts.map((_, index) => ({
      id: toEventId(`evt-${firstSeq + index}`),
      seq: firstSeq + index,
      branchId: toBranchId('branch-1'),
      runId: toRunId('run-1'),
      depth: 0,
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    })),
  })

const eventsFrom = (drafts: readonly EventDraft[]): Event[] => stampedFrom({ drafts, firstSeq: 1 })

const said = (text: string): EventDraft => ({ type: 'user-said', text })
const replied = (text: string): EventDraft => ({
  type: 'assistant-said',
  parts: [{ type: 'text', text }],
})
const called = (callId: string): EventDraft => ({
  type: 'tool-called',
  callId: toCallId(callId),
  name: 'bash',
  input: { command: 'rm -rf build' },
  ordinal: 0,
})
const resulted = (callId: string): EventDraft => ({
  type: 'tool-result',
  callId: toCallId(callId),
  name: 'bash',
  output: { ok: true },
})
const compacted = (throughSeq: number, summary: string): EventDraft => ({
  type: 'history-compacted',
  throughSeq,
  summary,
  replaced: throughSeq,
})

const exchange = (): Event[] =>
  eventsFrom([said('clean the build'), replied('on it'), called('call-1'), resulted('call-1'), replied('done')])

const copyFork = (args: { events: readonly Event[]; seq: number }) =>
  forkTarget({ ...args, mode: EForkMode.Copy })

describe('forkTarget', () => {
  it('refuses a sequence the branch never reached', () => {
    expect(copyFork({ events: exchange(), seq: 6 })).toEqual({
      allowed: false,
      refusal: EForkRefusal.NoSuchTarget,
      reason: '6 is not a fork target on a branch holding sequences 1 through 5',
    })
    expect(copyFork({ events: exchange(), seq: -1 }).allowed).toBe(false)
    expect(copyFork({ events: exchange(), seq: 2.5 }).allowed).toBe(false)
  })

  it('refuses forking an empty prefix, which is a new conversation rather than a fork', () => {
    expect(copyFork({ events: exchange(), seq: 0 })).toMatchObject({
      allowed: false,
      refusal: EForkRefusal.NoSuchTarget,
    })
  })

  it('refuses a fork that would hand the new branch a dispatched but unsettled call', () => {
    const target = copyFork({ events: exchange(), seq: 3 })

    expect(target.allowed).toBe(false)
    expect(target).toMatchObject({ refusal: EForkRefusal.UnsettledToolCall })
    if (!target.allowed) expect(target.reason).toContain('bash')
  })

  it('allows a fork whose prefix has every call settled', () => {
    expect(copyFork({ events: exchange(), seq: 4 })).toEqual({ allowed: true })
    expect(copyFork({ events: exchange(), seq: 2 })).toEqual({ allowed: true })
  })

  it('allows a fork at the last sequence the branch holds', () => {
    expect(copyFork({ events: exchange(), seq: 5 })).toEqual({ allowed: true })
  })

  it('allows a fork at a user message the branch never answered', () => {
    expect(copyFork({ events: exchange(), seq: 1 })).toEqual({ allowed: true })
  })

  it('judges the whole prefix, not the last event in it', () => {
    const events = eventsFrom([
      said('two tools'),
      called('call-1'),
      called('call-2'),
      resulted('call-1'),
      resulted('call-2'),
    ])

    expect(copyFork({ events, seq: 4 })).toMatchObject({
      allowed: false,
      refusal: EForkRefusal.UnsettledToolCall,
    })
    expect(copyFork({ events, seq: 5 })).toEqual({ allowed: true })
  })

  it('refuses a fork that would start the new branch on an approval nobody is going to answer', () => {
    const events = eventsFrom([
      said('delete it'),
      { type: 'approval-requested', callId: toCallId('call-1'), reason: 'bash writes' },
      { type: 'approval-answered', callId: toCallId('call-1'), decision: EDecision.Allow },
    ])

    expect(copyFork({ events, seq: 2 })).toMatchObject({
      allowed: false,
      refusal: EForkRefusal.UnansweredApproval,
    })
    expect(copyFork({ events, seq: 3 })).toEqual({ allowed: true })
  })

  it('bounds against the first sequence a branch still holds, not against zero', () => {
    const events = stampedFrom({
      drafts: [said('carry on from the fork'), replied('carrying on')],
      firstSeq: 5,
    })

    expect(copyFork({ events, seq: 5 })).toEqual({ allowed: true })
    expect(copyFork({ events, seq: 6 })).toEqual({ allowed: true })
    expect(copyFork({ events, seq: 4 })).toEqual({
      allowed: false,
      refusal: EForkRefusal.NoSuchTarget,
      reason: '4 is not a fork target on a branch holding sequences 5 through 6',
    })
  })

  it('allows a fork that drops a compaction the branch had applied', () => {
    const events = eventsFrom([
      said('hello'),
      replied('hi'),
      compacted(2, 'we said hello'),
      said('and now this'),
      replied('indeed'),
    ])

    expect(copyFork({ events, seq: 2 })).toEqual({ allowed: true })
    expect(copyFork({ events, seq: 5 })).toEqual({ allowed: true })
  })

  it('answers the same for either mode, because both give the new branch the same context', () => {
    const events = exchange()

    for (const seq of [0, 1, 2, 3, 4, 5, 6]) {
      const reference = forkTarget({ events, seq, mode: EForkMode.Reference })
      const copy = forkTarget({ events, seq, mode: EForkMode.Copy })

      expect(reference.allowed).toBe(copy.allowed)
      expect(reference.allowed === false && reference.refusal).toEqual(
        copy.allowed === false && copy.refusal,
      )
    }
  })

  it('names the mode in the sentence it refuses with', () => {
    const reference = forkTarget({ events: exchange(), seq: 3, mode: EForkMode.Reference })

    expect(reference.allowed === false && reference.reason).toContain('reference fork')
  })
})
