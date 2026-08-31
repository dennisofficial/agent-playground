import { describe, expect, it } from 'bun:test'

import { EKilledBy } from '../../shells/status'
import { EAgentStart } from '../start'
import { EAgentStatus } from '../status'
import type { Event } from '../../events/envelope'
import type { EventDraft } from '../../events/body'
import { toCallId, toEventId, toRunId, toThreadId } from '../../events/ids'
import { agentProgress, agentRoster, isLost, lostAgentEnding, unendedSpawns } from '../roster'

const PARENT = toThreadId('thread_parent')
const CHILD = toThreadId('thread_child')
const OTHER = toThreadId('thread_other')

let seq = 0

const rowOf = (draft: EventDraft, threadId = PARENT): Event => {
  seq += 1
  return {
    ...draft,
    id: toEventId(`event_${seq}`),
    seq,
    threadId,
    runId: toRunId(`run_${seq}`),
    depth: 0,
    at: `2026-08-31T00:00:0${seq}.000Z`,
  }
}

const spawned = (agentId = CHILD): EventDraft => ({
  type: 'agent-spawned',
  agentId,
  agentType: 'explore',
  intent: 'find the callers',
  mode: EAgentStart.Fresh,
})

const ended = ({
  agentId = CHILD,
  status = EAgentStatus.Finished,
  killedBy,
}: {
  agentId?: ReturnType<typeof toThreadId>
  status?: EAgentStatus
  killedBy?: EKilledBy
} = {}): EventDraft => ({
  type: 'agent-ended',
  agentId,
  agentType: 'explore',
  intent: 'find the callers',
  status,
  ...(killedBy === undefined ? {} : { killedBy }),
  prose: 'four callers',
  turns: 3,
  toolCalls: 7,
})

describe('the roster a parent rebuilds from its own log', () => {
  it('carries what the ending recorded, so a restart lists the same work', () => {
    const roster = agentRoster({
      events: [rowOf(spawned()), rowOf(ended())],
      threadId: PARENT,
    })

    expect(roster).toHaveLength(1)
    expect(roster[0]).toMatchObject({
      agentId: CHILD,
      agentType: 'explore',
      intent: 'find the callers',
      status: EAgentStatus.Finished,
      turns: 3,
      toolCalls: 7,
      prose: 'four callers',
    })
    expect(roster[0]?.endedAt).toBeDefined()
  })

  it('reports a spawn with no ending as stopped, because nothing is stepping it', () => {
    const roster = agentRoster({ events: [rowOf(spawned())], threadId: PARENT })

    expect(roster[0]?.status).toBe(EAgentStatus.Stopped)
    expect(roster[0]?.endedAt).toBeUndefined()
    expect(roster[0]?.spawnedAt).toBeDefined()
  })

  it('leaves a blocked ending blocked: the approval it waits on is still in the child log', () => {
    const roster = agentRoster({
      events: [rowOf(spawned()), rowOf(ended({ status: EAgentStatus.Blocked }))],
      threadId: PARENT,
    })

    expect(roster[0]?.status).toBe(EAgentStatus.Blocked)
  })

  it('reports a running ending as stopped, because the process that claimed it is gone', () => {
    const roster = agentRoster({
      events: [rowOf(spawned()), rowOf(ended({ status: EAgentStatus.Running }))],
      threadId: PARENT,
    })

    expect(roster[0]?.status).toBe(EAgentStatus.Stopped)
  })

  it('carries who stopped the child, so a restart still says the user did it', () => {
    const roster = agentRoster({
      events: [
        rowOf(spawned()),
        rowOf(ended({ status: EAgentStatus.Stopped, killedBy: EKilledBy.User })),
      ],
      threadId: PARENT,
    })

    expect(roster[0]?.killedBy).toBe(EKilledBy.User)
  })

  it('attributes a spawn with no ending to nobody, because nothing recorded a stop', () => {
    const roster = agentRoster({ events: [rowOf(spawned())], threadId: PARENT })

    expect(roster[0]?.killedBy).toBeUndefined()
  })

  it('takes the latest ending when a child was resumed and ended twice', () => {
    const roster = agentRoster({
      events: [
        rowOf(spawned()),
        rowOf(ended({ status: EAgentStatus.Failed })),
        rowOf(ended({ status: EAgentStatus.Finished })),
      ],
      threadId: PARENT,
    })

    expect(roster).toHaveLength(1)
    expect(roster[0]?.status).toBe(EAgentStatus.Finished)
  })

  it('reads only the rows the thread owns, never an inherited prefix', () => {
    const roster = agentRoster({
      events: [rowOf(spawned(), OTHER), rowOf(spawned(CHILD))],
      threadId: PARENT,
    })

    expect(roster.map((agent) => agent.agentId)).toEqual([CHILD])
  })

  it('is empty for a conversation that never spawned anything', () => {
    const roster = agentRoster({
      events: [rowOf({ type: 'user-said', text: 'hello' })],
      threadId: PARENT,
    })

    expect(roster).toEqual([])
  })
})

describe('the spawns with no ending behind them', () => {
  it('holds a child that was never ended', () => {
    const rows = [rowOf(spawned()), rowOf({ type: 'user-said', text: 'still going?' })]

    expect(unendedSpawns(rows).map((event) => event.agentId)).toEqual([CHILD])
  })

  it('drops a child once an ending records it, whatever the ending says', () => {
    expect(
      unendedSpawns([rowOf(spawned()), rowOf(ended({ status: EAgentStatus.Failed }))]),
    ).toEqual([])
  })

  it('holds a spawn whose ending belongs to a different child', () => {
    const spawn = rowOf(spawned(CHILD))

    expect(
      unendedSpawns([spawn, rowOf(ended({ agentId: OTHER, status: EAgentStatus.Finished }))]).map(
        (event) => event.agentId,
      ),
    ).toEqual([CHILD])
  })

  it('is empty for a conversation that never spawned anything', () => {
    expect(unendedSpawns([rowOf({ type: 'user-said', text: 'hello' })])).toEqual([])
  })
})

describe('the record recovery writes for a child the process lost', () => {
  const spoke = (text: string): EventDraft => ({
    type: 'assistant-said',
    parts: [{ type: 'text', text }],
  })
  const called = (name: string): EventDraft => ({
    type: 'tool-called',
    callId: toCallId(`call_${name}`),
    name,
    ordinal: 0,
  })

  it('reads a spawn with no ending as lost, and an ended child as kept', () => {
    const [lost] = agentRoster({ events: [rowOf(spawned())], threadId: PARENT })
    const [kept] = agentRoster({ events: [rowOf(spawned()), rowOf(ended())], threadId: PARENT })

    expect(lost === undefined ? undefined : isLost(lost)).toBe(true)
    expect(kept === undefined ? undefined : isLost(kept)).toBe(false)
  })

  it('counts the work out of the rows the child left behind', () => {
    const progress = agentProgress([
      { type: 'user-said', text: 'the brief' },
      spoke('looking'),
      called('read_file'),
      called('grep'),
      spoke('four callers, in two files'),
    ])

    expect(progress).toEqual({ turns: 2, toolCalls: 2, prose: 'four callers, in two files' })
  })

  it('keeps the last thing the child actually said', () => {
    expect(agentProgress([spoke('looking'), spoke('')]).prose).toBe('looking')
  })

  it('counts a child that was lost before it did anything', () => {
    expect(agentProgress([{ type: 'user-said', text: 'the brief' }])).toEqual({
      turns: 0,
      toolCalls: 0,
      prose: '',
    })
  })

  it('writes an ending that carries the work and blames nobody for it', () => {
    const draft = lostAgentEnding({
      agent: { agentId: CHILD, agentType: 'explore', intent: 'find the callers' },
      progress: { turns: 2, toolCalls: 5, prose: 'four callers' },
    })

    expect(draft).toEqual({
      type: 'agent-ended',
      agentId: CHILD,
      agentType: 'explore',
      intent: 'find the callers',
      status: EAgentStatus.Stopped,
      killedBy: EKilledBy.Unrecorded,
      prose: 'four callers',
      turns: 2,
      toolCalls: 5,
    })
  })
})
