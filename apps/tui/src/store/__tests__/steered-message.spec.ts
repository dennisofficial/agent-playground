import { describe, expect, it } from 'bun:test'

import { deriveTranscript } from '../derive-transcript'
import { EEntryKind, type TranscriptModel } from '../transcript-model'
import { fromTheOperator, log } from './fixture'
import { called, denied, result } from './tool-fixture'

const shapeOf = (model: TranscriptModel) =>
  model.entries.map((entry) => [entry.kind, entry.text] as const)

const steersOf = (model: TranscriptModel) =>
  fromTheOperator(model).map((entry) => [entry.text, entry.steer] as const)

describe('a message sent while the turn was still running', () => {
  it('marks the one that landed between a tool call and its result, and leaves the others plain', () => {
    const events = log([
      { type: 'user-said', text: 'find the loop' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'Looking.' }] },
      called({ n: 1, name: 'read' }),
      { type: 'user-said', text: 'check the tests too' },
      result({ n: 1, name: 'read' }),
      { type: 'assistant-said', parts: [{ type: 'text', text: 'Both read.' }] },
      { type: 'user-said', text: 'now write it up' },
    ])

    expect(steersOf(deriveTranscript({ events, signals: [] }))).toEqual([
      ['find the loop', false],
      ['check the tests too', true],
      ['now write it up', false],
    ])
  })

  it('keeps it in the transcript where it was said, rather than moving it past the result', () => {
    const events = log([
      called({ n: 1, name: 'read' }),
      { type: 'user-said', text: 'check the tests too' },
      result({ n: 1, name: 'read' }),
    ])

    expect(shapeOf(deriveTranscript({ events, signals: [] }))).toEqual([
      [EEntryKind.ToolsRan, 'Read 1 file'],
      [EEntryKind.OperatorSaid, 'check the tests too'],
    ])
  })

  it('marks it while several calls are still outstanding, not only the first', () => {
    const events = log([
      called({ n: 1, name: 'read' }),
      called({ n: 2, name: 'read' }),
      result({ n: 1, name: 'read' }),
      { type: 'user-said', text: 'check the tests too' },
      result({ n: 2, name: 'read' }),
    ])

    expect(steersOf(deriveTranscript({ events, signals: [] }))).toEqual([
      ['check the tests too', true],
    ])
  })

  it('stops counting a call as outstanding once it has been denied', () => {
    const events = log([
      called({ n: 1, name: 'read' }),
      denied({ n: 1, name: 'read', reason: 'not allowed' }),
      { type: 'user-said', text: 'try something else' },
    ])

    expect(steersOf(deriveTranscript({ events, signals: [] }))).toEqual([
      ['try something else', false],
    ])
  })

  it('leaves an ordinary opening message unmarked on a branch with no tools at all', () => {
    const events = log([
      { type: 'user-said', text: 'what derives the prompt' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'The log does.' }] },
      { type: 'user-said', text: 'say more' },
    ])

    expect(steersOf(deriveTranscript({ events, signals: [] }))).toEqual([
      ['what derives the prompt', false],
      ['say more', false],
    ])
  })
})
