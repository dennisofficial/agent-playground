import { describe, expect, it } from 'bun:test'

import type { EventDraft } from '../body'
import { dedupeCallIds } from '../dedupe-call-ids'
import { toCallId } from '../ids'

const called = (callId: string, ordinal = 0): EventDraft => ({
  type: 'tool-called',
  callId: toCallId(callId),
  name: 'bash',
  input: { command: 'true' },
  ordinal,
})

const resulted = (callId: string): EventDraft => ({
  type: 'tool-result',
  callId: toCallId(callId),
  name: 'bash',
  output: 'ok',
})

const denied = (callId: string): EventDraft => ({
  type: 'tool-denied',
  callId: toCallId(callId),
  name: 'bash',
  reason: 'cut short',
})

describe('dedupeCallIds', () => {
  it('leaves drafts alone when no id collides', () => {
    const drafts = [called('bash_1'), resulted('bash_1')]

    expect(dedupeCallIds({ drafts, taken: new Set() })).toEqual(drafts)
  })

  it('renames a call whose id the log already holds, and its result follows', () => {
    const drafts = [called('bash_181'), resulted('bash_181')]

    expect(dedupeCallIds({ drafts, taken: new Set(['bash_181']) })).toEqual([
      called('bash_181~2'),
      resulted('bash_181~2'),
    ])
  })

  it('renames the second of two calls sharing an id within one step', () => {
    const drafts = [called('bash_1', 0), called('bash_1', 1)]

    expect(dedupeCallIds({ drafts, taken: new Set() })).toEqual([
      called('bash_1', 0),
      called('bash_1~2', 1),
    ])
  })

  it('steps past a suffix that is also taken', () => {
    const drafts = [called('bash_181')]

    expect(dedupeCallIds({ drafts, taken: new Set(['bash_181', 'bash_181~2']) })).toEqual([
      called('bash_181~3'),
    ])
  })

  it('keeps an interrupted call linked to its own denial under the new id', () => {
    const drafts = [called('bash_181'), denied('bash_181')]

    expect(dedupeCallIds({ drafts, taken: new Set(['bash_181']) })).toEqual([
      called('bash_181~2'),
      denied('bash_181~2'),
    ])
  })

  it('renames each repeated call afresh, never handing the same new id out twice', () => {
    const drafts = [called('bash_181', 0), denied('bash_181'), called('bash_181', 1), denied('bash_181')]

    expect(dedupeCallIds({ drafts, taken: new Set(['bash_181']) })).toEqual([
      called('bash_181~2', 0),
      denied('bash_181~2'),
      called('bash_181~3', 1),
      denied('bash_181~3'),
    ])
  })

  it('leaves drafts that carry no call id untouched', () => {
    const drafts: EventDraft[] = [
      { type: 'assistant-said', parts: [{ type: 'text', text: 'on it' }] },
      { type: 'nudge', text: 'keep going', lifetimeSteps: 1 },
    ]

    expect(dedupeCallIds({ drafts, taken: new Set(['bash_1']) })).toEqual(drafts)
  })
})
