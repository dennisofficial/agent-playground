import { ECompactionAnchor } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { deriveTranscript } from '../derive-transcript'
import { EEntryKind } from '../transcript-model'
import { log } from './fixture'

describe('the transcript across a compaction', () => {
  it('still shows the turns the model can no longer read, with the summary between them', () => {
    const events = log([
      { type: 'user-said', text: 'build the parser' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'done' }] },
      {
        type: 'history-compacted',
        anchor: ECompactionAnchor.Prefix,
        fromSeq: 1,
        throughSeq: 2,
        summary: 'A parser was written.',
        replaced: 2,
      },
      { type: 'user-said', text: 'now the lexer' },
    ])

    const model = deriveTranscript({ events, signals: [] })

    expect(model.entries.map((entry) => [entry.kind, entry.text])).toEqual([
      [EEntryKind.OperatorSaid, 'build the parser'],
      [EEntryKind.ModelSaid, 'done'],
      [EEntryKind.HistoryCompacted, 'A parser was written.'],
      [EEntryKind.OperatorSaid, 'now the lexer'],
    ])
  })

  it('counts how much of the thread the summary stands in for', () => {
    const events = log([
      { type: 'user-said', text: 'first' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'one' }] },
      { type: 'user-said', text: 'second' },
      {
        type: 'history-compacted',
        anchor: ECompactionAnchor.Prefix,
        fromSeq: 1,
        throughSeq: 3,
        summary: 'two exchanges',
        replaced: 3,
      },
    ])

    const compacted = deriveTranscript({ events, signals: [] }).entries.find(
      (entry) => entry.kind === EEntryKind.HistoryCompacted,
    )

    expect(compacted?.kind === EEntryKind.HistoryCompacted && compacted.compactedEntries).toBe(3)
  })
})
