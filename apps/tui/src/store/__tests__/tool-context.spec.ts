import { EContextSlot, toCallId, toEventId, toRunId, toThreadId, type Event } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { toolRuns } from '../tool-runs'

let seq = 0

const envelope = () => {
  seq += 1
  return {
    id: toEventId(`e${seq}`),
    seq,
    threadId: toThreadId('t'),
    runId: toRunId('r'),
    depth: 0,
    at: '2026-09-08T00:00:00.000Z',
  }
}

const called = (n: number, name = 'bash'): Event =>
  ({
    ...envelope(),
    type: 'tool-called',
    callId: toCallId(`call-${n}`),
    name,
    input: {},
    ordinal: n,
  }) as Event

const resulted = (n: number, name = 'bash'): Event =>
  ({
    ...envelope(),
    type: 'tool-result',
    callId: toCallId(`call-${n}`),
    name,
    output: 'ok',
  }) as Event

const loaded = (args: { slot: string; key?: string; content: string }): Event =>
  ({
    ...envelope(),
    type: 'context-loaded',
    slot: args.slot,
    key: args.key ?? 'additional-context',
    content: args.content,
  }) as Event

const said = (text: string): Event => ({ ...envelope(), type: 'user-said', text })

const onlyCall = (events: readonly Event[]) => {
  const call = toolRuns(events)[0]?.calls[0]
  if (call === undefined) throw new Error('expected a tool call')
  return call
}

describe('context a hook injected around a tool call', () => {
  it('attaches to the call whose result it followed', () => {
    const call = onlyCall([called(1), resulted(1), loaded({ slot: 'gitState', content: '3 files dirty' })])

    expect(call.attachments).toHaveLength(1)
    expect(call.attachments[0]?.slot).toBe('gitState')
    expect(call.attachments[0]?.content).toBe('3 files dirty')
  })

  it('attaches to the call it ran ahead of', () => {
    const call = onlyCall([called(1), loaded({ slot: 'readBeforeWrite', content: 'read it first' }), resulted(1)])

    expect(call.attachments[0]?.slot).toBe('readBeforeWrite')
  })

  it('keeps hooks that spoke back to back as separate attachments of one call', () => {
    const call = onlyCall([
      called(1),
      resulted(1),
      loaded({ slot: 'gitState', content: 'dirty' }),
      loaded({ slot: 'plan', content: 'open' }),
    ])

    expect(call.attachments.map((attachment) => attachment.slot)).toEqual(['gitState', 'plan'])
  })

  it('attaches each injection to its own call when calls run back to back', () => {
    const run = toolRuns([
      called(1),
      resulted(1),
      loaded({ slot: 'gitState', content: 'dirty' }),
      called(2),
      resulted(2),
      loaded({ slot: 'plan', content: 'open' }),
    ])[0]

    expect(run?.calls[0]?.attachments.map((attachment) => attachment.slot)).toEqual(['gitState'])
    expect(run?.calls[1]?.attachments.map((attachment) => attachment.slot)).toEqual(['plan'])
  })

  it('names an instruction file attachment by its path', () => {
    const call = onlyCall([
      called(1, 'read'),
      resulted(1, 'read'),
      loaded({ slot: EContextSlot.NestedInstructions, key: '/repo/apps/api/CLAUDE.md', content: '# rules' }),
    ])

    expect(call.attachments[0]?.name).toBe('/repo/apps/api/CLAUDE.md')
  })
})

describe('context loads that no tool call sourced', () => {
  it('leaves turn-start instruction loads unattached', () => {
    const run = toolRuns([
      said('hello'),
      loaded({ slot: EContextSlot.ProjectInstructions, key: '/repo/CLAUDE.md', content: 'rules' }),
    ])

    expect(run).toEqual([])
  })

  it('leaves skill and file message badges unattached', () => {
    const call = onlyCall([
      called(1),
      resulted(1),
      loaded({ slot: EContextSlot.File, key: '/repo/README.md', content: 'body' }),
    ])

    expect(call.attachments).toEqual([])
  })

  it('stops attributing once the operator speaks again', () => {
    const events = [
      called(1),
      resulted(1),
      said('next'),
      loaded({ slot: 'gitState', content: 'dirty' }),
    ]

    expect(toolRuns(events)[0]?.calls[0]?.attachments).toEqual([])
  })
})
