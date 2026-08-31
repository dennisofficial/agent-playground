import { describe, expect, it } from 'bun:test'

import { EAgentStart } from '../start'
import { EAgentStatus } from '../status'
import type { Event } from '../../events/envelope'
import type { EventDraft } from '../../events/body'
import { toEventId, toRunId, toThreadId } from '../../events/ids'
import { agentRoster } from '../roster'

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
}: { agentId?: ReturnType<typeof toThreadId>; status?: EAgentStatus } = {}): EventDraft => ({
  type: 'agent-ended',
  agentId,
  agentType: 'explore',
  intent: 'find the callers',
  status,
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
