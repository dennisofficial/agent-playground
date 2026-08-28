import { describe, expect, it } from 'bun:test'

import { deriveTranscript } from '../derive-transcript'
import { EAuthor, EEntryKind, type TranscriptModel } from '../transcript-model'
import { fromTheOperator, log } from './fixture'
import { called, result } from './tool-fixture'

const shapeOf = (model: TranscriptModel) =>
  model.entries.map((entry) => [entry.kind, entry.text] as const)

describe('two messages sent one after the other', () => {
  it('reads as one block, with a line for each of them', () => {
    const events = log([
      { type: 'user-said', text: 'are' },
      { type: 'user-said', text: 'you?' },
    ])

    expect(fromTheOperator(deriveTranscript({ events, signals: [] }))).toEqual([
      {
        kind: EEntryKind.OperatorSaid,
        author: EAuthor.Operator,
        key: 'event-1',
        text: 'are\nyou?',
        said: ['are', 'you?'],
        steer: false,
    skills: [],
      },
    ])
  })

  it('keeps a reply between them apart, however short it was', () => {
    const events = log([
      { type: 'user-said', text: 'hello' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'Hi.' }] },
      { type: 'user-said', text: 'how' },
    ])

    expect(shapeOf(deriveTranscript({ events, signals: [] }))).toEqual([
      [EEntryKind.OperatorSaid, 'hello'],
      [EEntryKind.ModelSaid, 'Hi.'],
      [EEntryKind.OperatorSaid, 'how'],
    ])
  })

  it('leaves one sent mid-turn on its own, since only it carries the mark', () => {
    const events = log([
      called({ n: 1, name: 'read' }),
      { type: 'user-said', text: 'check the tests too' },
      result({ n: 1, name: 'read' }),
      { type: 'user-said', text: 'and the fixtures' },
    ])

    expect(fromTheOperator(deriveTranscript({ events, signals: [] })).map((entry) => entry.said)).toEqual([
      ['check the tests too'],
      ['and the fixtures'],
    ])
  })

  it('folds a whole run of them, not only the last two', () => {
    const events = log([
      { type: 'user-said', text: 'one' },
      { type: 'user-said', text: 'two' },
      { type: 'user-said', text: 'three' },
    ])

    expect(fromTheOperator(deriveTranscript({ events, signals: [] })).map((entry) => entry.said)).toEqual([
      ['one', 'two', 'three'],
    ])
  })
})
