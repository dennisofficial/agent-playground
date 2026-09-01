import { describe, expect, it } from 'bun:test'

import { EAgentStart, EAgentStatus, EKilledBy, toThreadId, type Event } from '@dltech/atlas-core'

import { durableEntries } from '../durable-entries'
import { isExpandable } from '../expandable'
import { EEntryKind, type AgentEndedEntry } from '../transcript-model'
import { log } from './fixture'

const REPORT =
  'Every call site is in `packages/harness/src/loop`. Nothing outside it touches the port.'

const childId = toThreadId('thread-child')

const agentEnded = (over: Record<string, unknown> = {}) => ({
  type: 'agent-ended' as const,
  agentId: childId,
  agentType: 'explore',
  intent: 'audit the credential vault',
  status: EAgentStatus.Finished,
  prose: REPORT,
  turns: 3,
  toolCalls: 12,
  ...over,
})

const agentSpawned = (over: Record<string, unknown> = {}) => ({
  type: 'agent-spawned' as const,
  agentId: childId,
  agentType: 'explore',
  intent: 'audit the credential vault',
  mode: EAgentStart.Fresh,
  ...over,
})

const onlyAgentEntry = (events: readonly Event[]): AgentEndedEntry => {
  const entry = durableEntries({ events }).find(
    (candidate): candidate is AgentEndedEntry => candidate.kind === EEntryKind.AgentEnded,
  )
  if (entry === undefined) throw new Error('no sub-agent entry was projected')
  return entry
}

describe('a sub-agent ending in the transcript', () => {
  it('is its own entry rather than something the model said', () => {
    const entries = durableEntries({ events: log([agentEnded()]) })

    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe(EEntryKind.AgentEnded)
  })

  it('names the child by what it was doing and counts the work it did', () => {
    expect(onlyAgentEntry(log([agentEnded()])).text).toBe(
      'Sub-agent explore "audit the credential vault" finished after 3 turns and 12 tool calls',
    )
  })

  it('falls back to the type when the child was spawned without an intent', () => {
    expect(onlyAgentEntry(log([agentEnded({ intent: '' })])).text).toBe(
      'Sub-agent explore finished after 3 turns and 12 tool calls',
    )
  })

  it('says a failure was a failure, so the line can be read at a glance', () => {
    const entry = onlyAgentEntry(log([agentEnded({ status: EAgentStatus.Failed })]))

    expect(entry.text).toBe(
      'Sub-agent explore "audit the credential vault" failed after 3 turns and 12 tool calls',
    )
    expect(entry.failed).toBe(true)
  })

  it('does not read a child the operator stopped as a failure', () => {
    const entry = onlyAgentEntry(log([agentEnded({ status: EAgentStatus.Stopped })]))

    expect(entry.text).toContain('was stopped after')
    expect(entry.failed).toBe(false)
  })

  it('says who stopped a child, rather than leaving the operator to guess', () => {
    const entry = onlyAgentEntry(
      log([agentEnded({ status: EAgentStatus.Stopped, killedBy: EKilledBy.User })]),
    )

    expect(entry.text).toContain('was stopped by the user after')
    expect(entry.failed).toBe(false)
  })

  it('marks a child blocked on an approval, because it cannot make progress on its own', () => {
    const entry = onlyAgentEntry(log([agentEnded({ status: EAgentStatus.Blocked })]))

    expect(entry.text).toContain('is blocked on an approval it cannot answer')
    expect(entry.failed).toBe(true)
  })

  it('does not read a blocked child as one somebody chose to stop', () => {
    expect(onlyAgentEntry(log([agentEnded({ status: EAgentStatus.Blocked })])).text).not.toContain(
      'was stopped',
    )
  })

  it('keeps the report for the fold rather than putting it on the line', () => {
    const entry = onlyAgentEntry(log([agentEnded()]))

    expect(entry.text).not.toContain('call site')
    expect(entry.report).toBe(REPORT)
    expect(isExpandable(entry)).toBe(true)
  })

  it('does not offer a fold when the child reported nothing', () => {
    expect(isExpandable(onlyAgentEntry(log([agentEnded({ prose: '' })])))).toBe(false)
  })

  it('carries the child so the row can lead back to the thread that wrote it', () => {
    expect(onlyAgentEntry(log([agentEnded()])).agentId).toBe(childId)
  })

  it('shows nothing for the spawn, which the tool call the model made already said', () => {
    expect(durableEntries({ events: log([agentSpawned()]) })).toEqual([])
  })

  it('never folds into the message a human typed beside it', () => {
    const entries = durableEntries({
      events: log([
        { type: 'user-said', text: 'go and check' },
        agentEnded(),
        { type: 'user-said', text: 'thanks' },
      ]),
    })

    expect(entries.map((entry) => entry.kind)).toEqual([
      EEntryKind.OperatorSaid,
      EEntryKind.AgentEnded,
      EEntryKind.OperatorSaid,
    ])
  })

  it('gives each ending in a wave its own row', () => {
    const entries = durableEntries({
      events: log([
        agentEnded(),
        agentEnded({ agentId: toThreadId('thread-other'), intent: 'review the diff' }),
      ]),
    })

    expect(entries).toHaveLength(2)
    expect(entries.map((entry) => entry.key)).toEqual(['event-1', 'event-2'])
  })
})
