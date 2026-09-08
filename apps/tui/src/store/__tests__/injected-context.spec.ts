import { EContextSlot, toCallId, toEventId, toRunId, toThreadId, type Event } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { durableEntries } from '../durable-entries'
import { isExpandable } from '../expandable'
import { EEntryKind, type ContextLoadedEntry, type OperatorSaidEntry } from '../transcript-model'

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

const called = (n: number): Event =>
  ({
    ...envelope(),
    type: 'tool-called',
    callId: toCallId(`call-${n}`),
    name: 'bash',
    input: {},
    ordinal: n,
  }) as Event

const resulted = (n: number): Event =>
  ({
    ...envelope(),
    type: 'tool-result',
    callId: toCallId(`call-${n}`),
    name: 'bash',
    output: 'ok',
  }) as Event

const hookContext = (args: { slot: string; key?: string; content: string }): Event =>
  ({
    ...envelope(),
    type: 'context-loaded',
    slot: args.slot,
    key: args.key ?? 'additional-context',
    content: args.content,
  }) as Event

const fileMention = (path: string): Event =>
  ({ ...envelope(), type: 'context-loaded', slot: EContextSlot.File, key: path, content: 'body' }) as Event

const said = (text: string): Event => ({ ...envelope(), type: 'user-said', text })

const contextEntries = (events: readonly Event[]): ContextLoadedEntry[] =>
  durableEntries({ events }).filter(
    (entry): entry is ContextLoadedEntry => entry.kind === EEntryKind.ContextLoaded,
  )

describe('context a hook injected around a tool call', () => {
  it('renders as a one-liner straight after the tool block', () => {
    const entries = durableEntries({
      events: [called(1), resulted(1), hookContext({ slot: 'gitState', content: '3 files dirty' })],
    })

    expect(entries.map((entry) => entry.kind)).toEqual([EEntryKind.ToolsRan, EEntryKind.ContextLoaded])
  })

  it('names the hook that spoke and carries what it injected', () => {
    const [entry] = contextEntries([
      called(1),
      resulted(1),
      hookContext({ slot: 'gitState', content: '3 files dirty' }),
    ])

    expect(entry?.text).toBe('Context: gitState')
    expect(entry?.body).toContain('gitState')
    expect(entry?.body).toContain('3 files dirty')
  })

  it('folds hooks that spoke back to back into a single line', () => {
    const entries = contextEntries([
      called(1),
      resulted(1),
      hookContext({ slot: 'gitState', content: '3 files dirty' }),
      hookContext({ slot: 'plan', content: '2 tasks open' }),
    ])

    expect(entries).toHaveLength(1)
    expect(entries[0]?.text).toBe('Context: gitState, plan')
    expect(entries[0]?.body).toContain('3 files dirty')
    expect(entries[0]?.body).toContain('2 tasks open')
  })

  it('keeps injections from separate tool calls on separate lines', () => {
    const entries = contextEntries([
      called(1),
      resulted(1),
      hookContext({ slot: 'gitState', content: 'dirty' }),
      called(2),
      resulted(2),
      hookContext({ slot: 'plan', content: 'open' }),
    ])

    expect(entries).toHaveLength(2)
  })

  it('surfaces a hook that spoke before the tool ran', () => {
    const entries = contextEntries([
      called(1),
      hookContext({ slot: 'readBeforeWrite', content: 'read it first' }),
      resulted(1),
    ])

    expect(entries).toHaveLength(1)
    expect(entries[0]?.text).toBe('Context: readBeforeWrite')
  })

  it('labels an instruction file a tool pull touched with its path', () => {
    const [entry] = contextEntries([
      called(1),
      resulted(1),
      hookContext({
        slot: EContextSlot.NestedInstructions,
        key: '/repo/src/CLAUDE.md',
        content: '# rules',
      }),
    ])

    expect(entry?.text).toBe('Context: /repo/src/CLAUDE.md')
    expect(entry?.body).toContain('# rules')
  })

  it('is expandable so enter and click can unfold the injected text', () => {
    const [entry] = contextEntries([
      called(1),
      resulted(1),
      hookContext({ slot: 'gitState', content: '3 files dirty' }),
    ])

    if (entry === undefined) throw new Error('expected a context entry')
    expect(isExpandable(entry)).toBe(true)
  })
})

describe('context loads that are not tool-call injections', () => {
  it('stays quiet for instruction files loaded at the start of a turn', () => {
    const entries = contextEntries([
      said('hello'),
      hookContext({ slot: EContextSlot.ProjectInstructions, key: '/repo/CLAUDE.md', content: 'rules' }),
    ])

    expect(entries).toEqual([])
  })

  it('stays quiet for a load with no tool call behind it', () => {
    const entries = contextEntries([hookContext({ slot: 'gitState', content: 'dirty' })])

    expect(entries).toEqual([])
  })

  it('keeps @-mentioned files on the message badge rather than a context line', () => {
    const events = [called(1), resulted(1), fileMention('/repo/README.md'), said('look at this')]

    expect(contextEntries(events)).toEqual([])
    const operator = durableEntries({ events }).find(
      (entry): entry is OperatorSaidEntry => entry.kind === EEntryKind.OperatorSaid,
    )
    expect(operator?.files).toEqual(['/repo/README.md'])
  })
})
