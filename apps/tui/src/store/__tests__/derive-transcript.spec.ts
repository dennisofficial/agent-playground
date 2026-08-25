import { describe, expect, it } from 'bun:test'

import { deriveTranscript } from '../derive-transcript'
import { EAuthor, EEntryKind } from '../transcript-model'
import { fromTheModel, log, reasoningDelta, started, stepOne, textDelta } from './fixture'

describe('an empty branch', () => {
  it('derives a usable empty transcript rather than an error', () => {
    const model = deriveTranscript({ events: [], signals: [] })

    expect(model.entries).toEqual([])
    expect(model.isEmpty).toBe(true)
    expect(model.streaming).toBe(false)
    expect(model.failure).toBeNull()
  })
})

describe('a settled exchange', () => {
  it('marks the operator as the author of their own message and the model as the author of the reply', () => {
    const events = log([
      { type: 'user-said', text: 'what is a monad' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'a burrito' }] },
    ])

    const model = deriveTranscript({ events, signals: [] })

    expect(model.entries.map((entry) => [entry.author, entry.kind, entry.text])).toEqual([
      [EAuthor.Operator, EEntryKind.OperatorSaid, 'what is a monad'],
      [EAuthor.Model, EEntryKind.ModelSaid, 'a burrito'],
    ])
    expect(model.isEmpty).toBe(false)
  })

  it('renders reasoning as thinking, ahead of the answer it preceded', () => {
    const events = log([
      {
        type: 'assistant-said',
        parts: [
          { type: 'reasoning', text: 'weighing it up' },
          { type: 'text', text: 'a burrito' },
        ],
      },
    ])

    const model = deriveTranscript({ events, signals: [] })

    expect(model.entries.map((entry) => [entry.kind, entry.text])).toEqual([
      [EEntryKind.ModelThought, 'weighing it up'],
      [EEntryKind.ModelSaid, 'a burrito'],
    ])
  })

  it('gives every entry a distinct key', () => {
    const events = log([
      { type: 'user-said', text: 'hello' },
      {
        type: 'assistant-said',
        parts: [
          { type: 'reasoning', text: 'thinking' },
          { type: 'text', text: 'hi' },
        ],
      },
    ])

    const keys = deriveTranscript({ events, signals: [] }).entries.map((entry) => entry.key)

    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('deltas in flight', () => {
  it('renders text deltas that have no durable event yet, as a streaming model answer', () => {
    const events = log([{ type: 'user-said', text: 'hello' }])
    const signals = [
      started(stepOne),
      textDelta({ stepId: stepOne, blockId: 'b1', text: 'hi ' }),
      textDelta({ stepId: stepOne, blockId: 'b1', text: 'there' }),
    ]

    const model = deriveTranscript({ events, signals })

    expect(model.entries.map((entry) => [entry.kind, entry.text])).toEqual([
      [EEntryKind.OperatorSaid, 'hello'],
      [EEntryKind.ModelSaid, 'hi there'],
    ])
    expect(fromTheModel(model).at(-1)?.streaming).toBe(true)
    expect(model.streaming).toBe(true)
  })

  it('renders reasoning deltas as thinking, ahead of the answer streaming after them', () => {
    const signals = [
      started(stepOne),
      reasoningDelta({ stepId: stepOne, blockId: 'r1', text: 'hmm' }),
      textDelta({ stepId: stepOne, blockId: 't1', text: 'yes' }),
    ]

    const model = deriveTranscript({ events: [], signals })

    expect(model.entries.map((entry) => [entry.kind, entry.text])).toEqual([
      [EEntryKind.ModelThought, 'hmm'],
      [EEntryKind.ModelSaid, 'yes'],
    ])
  })

  it('is streaming from the moment a step starts, before any delta arrives', () => {
    const model = deriveTranscript({ events: [], signals: [started(stepOne)] })

    expect(model.streaming).toBe(true)
    expect(model.entries).toEqual([])
    expect(model.isEmpty).toBe(true)
  })
})

