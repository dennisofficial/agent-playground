import { describe, expect, it } from 'bun:test'

import { EToolEffect } from '../../tools/tool'
import type { EventDraft } from '../body'
import type { Event } from '../envelope'
import { toCallId, toEventId, toRunId, toThreadId } from '../ids'
import { stampDrafts } from '../stamp'
import { treeMutationsOf } from '../tree-mutations'

const eventsFrom = (drafts: readonly EventDraft[]): Event[] =>
  stampDrafts({
    drafts,
    envelopes: drafts.map((_, index) => ({
      id: toEventId(`evt-${index + 1}`),
      seq: index + 1,
      threadId: toThreadId('thread-1'),
      runId: toRunId('run-1'),
      depth: 0,
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    })),
  })

const result = (args: { callId: string; name: string }): EventDraft => ({
  type: 'tool-result',
  callId: toCallId(args.callId),
  name: args.name,
  output: 'done',
})

describe('treeMutationsOf', () => {
  it('counts tool results from tools whose effect writes', () => {
    const events = eventsFrom([
      result({ callId: '1', name: 'write' }),
      result({ callId: '2', name: 'bash' }),
    ])

    expect(treeMutationsOf({ events, effects: () => EToolEffect.Write })).toBe(2)
  })

  it('ignores read-effect results, denied calls, and mere invocations', () => {
    const events = eventsFrom([
      { type: 'tool-called', callId: toCallId('1'), name: 'write', ordinal: 0 },
      result({ callId: '2', name: 'read' }),
      { type: 'tool-denied', callId: toCallId('3'), name: 'write', reason: 'no' },
      result({ callId: '4', name: 'write' }),
    ])
    const effects = (name: string): EToolEffect =>
      name === 'read' ? EToolEffect.Read : EToolEffect.Write

    expect(treeMutationsOf({ events, effects })).toBe(1)
  })

  it('counts results from tools the registry cannot name, like MCP tools', () => {
    const events = eventsFrom([result({ callId: '1', name: 'mcp__fs__write' })])

    expect(treeMutationsOf({ events, effects: () => undefined })).toBe(1)
  })

  it('counts an errored result, since the call may have written before failing', () => {
    const events = eventsFrom([
      {
        type: 'tool-result',
        callId: toCallId('1'),
        name: 'bash',
        error: { message: 'exit 1' },
      },
    ])

    expect(treeMutationsOf({ events, effects: () => EToolEffect.Destructive })).toBe(1)
  })
})
