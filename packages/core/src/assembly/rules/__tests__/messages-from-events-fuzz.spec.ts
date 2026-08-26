import { describe, expect, it } from 'bun:test'

import { EDecision, type EventDraft } from '../../../events/body'
import { toCallId } from '../../../events/ids'
import { EExchangeFault, exchangeFaults } from '../../exchange-shape'
import { contextFor, log } from '../../__tests__/log-fixture'
import { messagesFromEvents } from '../messages-from-events'

const c0 = toCallId('call-0')
const c1 = toCallId('call-1')

const ALPHABET: Readonly<Record<string, EventDraft>> = {
  user: { type: 'user-said', text: 'go' },
  said: { type: 'assistant-said', parts: [{ type: 'text', text: 'working' }] },
  call0: { type: 'tool-called', callId: c0, name: 'read', input: { path: 'a' }, ordinal: 0 },
  call0again: { type: 'tool-called', callId: c0, name: 'read', input: { path: 'dup' }, ordinal: 1 },
  call1: { type: 'tool-called', callId: c1, name: 'read', input: { path: 'b' }, ordinal: 1 },
  result0: { type: 'tool-result', callId: c0, name: 'read', output: 'a', modelText: 'a' },
  result0again: { type: 'tool-result', callId: c0, name: 'read', output: 'a2', modelText: 'a2' },
  result1: { type: 'tool-result', callId: c1, name: 'read', output: 'b', modelText: 'b' },
  denied1: { type: 'tool-denied', callId: c1, name: 'read', reason: 'nope' },
  loaded: { type: 'context-loaded', slot: 'project', key: 'CLAUDE.md', content: 'rules' },
  asked: { type: 'approval-requested', callId: c1, reason: 'destructive' },
  answered: { type: 'approval-answered', callId: c1, decision: EDecision.Allow },
}

const PROJECTION_OWNS: readonly EExchangeFault[] = [
  EExchangeFault.RepeatedCallId,
  EExchangeFault.RepeatedResultId,
  EExchangeFault.UnansweredCall,
  EExchangeFault.UnmatchedResult,
  EExchangeFault.ResultAfterOtherContent,
  EExchangeFault.EmptyContent,
]

const MAX_LENGTH = 4

function everySequenceUpTo(length: number): string[][] {
  const kinds = Object.keys(ALPHABET)
  const sequences: string[][] = []

  const extend = (prefix: string[]) => {
    if (prefix.length > 0) sequences.push(prefix)
    if (prefix.length === length) return
    for (const kind of kinds) extend([...prefix, kind])
  }

  extend([])
  return sequences
}

const draftsOf = (sequence: readonly string[]): EventDraft[] =>
  sequence.flatMap((kind) => {
    const draft = ALPHABET[kind]
    return draft === undefined ? [] : [draft]
  })

describe('messagesFromEvents over every short event sequence', () => {
  it('never projects a shape the exchange validator faults it for', () => {
    const owned = new Set<EExchangeFault>(PROJECTION_OWNS)
    const offenders: string[] = []

    for (const sequence of everySequenceUpTo(MAX_LENGTH)) {
      const assembled = messagesFromEvents()(
        { system: [], messages: [] },
        contextFor({ events: log(draftsOf(sequence)) }),
      )
      const faults = exchangeFaults(assembled).filter((fault) => owned.has(fault.fault))

      if (faults.length > 0 && offenders.length < 5) {
        offenders.push(`${sequence.join(' ')} -> ${faults.map((fault) => fault.fault).join(' + ')}`)
      }
    }

    expect(offenders).toEqual([])
  })
})
