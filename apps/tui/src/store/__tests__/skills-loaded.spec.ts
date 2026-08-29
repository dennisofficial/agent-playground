import { EContextSlot, toEventId, toRunId, toThreadId, type Event } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { durableEntries } from '../durable-entries'
import { EEntryKind, type OperatorSaidEntry } from '../transcript-model'

let seq = 0

const envelope = () => {
  seq += 1
  return {
    id: toEventId(`e${seq}`),
    seq,
    threadId: toThreadId('t'),
    runId: toRunId('r'),
    depth: 0,
    at: '2026-08-27T00:00:00.000Z',
  }
}

const skillLoaded = (key: string): Event =>
  ({ ...envelope(), type: 'context-loaded', slot: EContextSlot.Skill, key, content: 'body' }) as Event

const instructionsLoaded = (key: string): Event =>
  ({
    ...envelope(),
    type: 'context-loaded',
    slot: EContextSlot.ProjectInstructions,
    key,
    content: 'body',
  })

const said = (text: string): Event => ({ ...envelope(), type: 'user-said', text })

const replied = (text: string): Event =>
  ({ ...envelope(), type: 'assistant-said', parts: [{ type: 'text', text }] })

const operatorEntries = (events: readonly Event[]): OperatorSaidEntry[] =>
  durableEntries({ events }).filter(
    (entry): entry is OperatorSaidEntry => entry.kind === EEntryKind.OperatorSaid,
  )

describe('skills loaded with a message', () => {
  it('names the skill the message pulled in', () => {
    const entries = operatorEntries([skillLoaded('pirate'), said('/pirate hello')])

    expect(entries[0]?.skills).toEqual(['pirate'])
  })

  it('names every skill of a chained invocation', () => {
    const entries = operatorEntries([
      skillLoaded('tdd'),
      skillLoaded('implement'),
      said('/tdd /implement do X'),
    ])

    expect(entries[0]?.skills).toEqual(['tdd', 'implement'])
  })

  it('leaves a plain message unmarked', () => {
    expect(operatorEntries([said('fix the build')])[0]?.skills).toEqual([])
  })

  it('ignores instruction files, which are not skills', () => {
    const entries = operatorEntries([instructionsLoaded('/repo/CLAUDE.md'), said('hello')])

    expect(entries[0]?.skills).toEqual([])
  })

  it('does not attach a skill to a later, unrelated message', () => {
    const entries = operatorEntries([
      skillLoaded('pirate'),
      said('/pirate hello'),
      replied('arr'),
      said('and now plainly'),
    ])

    expect(entries[0]?.skills).toEqual(['pirate'])
    expect(entries[1]?.skills).toEqual([])
  })

  it('carries the skills through when two messages fold into one breath', () => {
    const entries = operatorEntries([skillLoaded('pirate'), said('/pirate hello'), said('and again')])

    expect(entries).toHaveLength(1)
    expect(entries[0]?.skills).toEqual(['pirate'])
  })
})
