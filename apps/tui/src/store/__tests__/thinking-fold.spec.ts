import { describe, expect, it } from 'bun:test'

import { foldThoughts, EThinkingVisibility, thinkingVisibilityOf } from '../thinking-fold'
import { EAuthor, EEntryKind, type TranscriptEntry } from '../transcript-model'

const thought = (args: {
  key: string
  text: string
  streaming?: boolean
  interrupted?: boolean
}): TranscriptEntry => ({
  kind: EEntryKind.ModelThought,
  author: EAuthor.Model,
  key: args.key,
  text: args.text,
  streaming: args.streaming ?? false,
  interrupted: args.interrupted ?? false,
})

const said = (args: { key: string; text: string }): TranscriptEntry => ({
  kind: EEntryKind.ModelSaid,
  author: EAuthor.Model,
  key: args.key,
  text: args.text,
  streaming: false,
  interrupted: false,
})

const shape = (entries: readonly TranscriptEntry[]) =>
  entries.map((entry) => [entry.kind, entry.key, entry.text])

describe('folding adjacent thoughts', () => {
  it('joins a run of thoughts into one block under the first key', () => {
    const folded = foldThoughts({
      entries: [
        thought({ key: 'a', text: 'first' }),
        thought({ key: 'b', text: 'second' }),
        thought({ key: 'c', text: 'third' }),
      ],
      visibility: EThinkingVisibility.Keep,
    })

    expect(shape(folded)).toEqual([[EEntryKind.ModelThought, 'a', 'first\n\nsecond\n\nthird']])
  })

  it('keeps thoughts apart when anything was said or run between them', () => {
    const folded = foldThoughts({
      entries: [
        thought({ key: 'a', text: 'first' }),
        said({ key: 'answer', text: 'a burrito' }),
        thought({ key: 'b', text: 'second' }),
      ],
      visibility: EThinkingVisibility.Keep,
    })

    expect(shape(folded)).toEqual([
      [EEntryKind.ModelThought, 'a', 'first'],
      [EEntryKind.ModelSaid, 'answer', 'a burrito'],
      [EEntryKind.ModelThought, 'b', 'second'],
    ])
  })

  it('leaves a fold streaming while any thought in it still is', () => {
    const folded = foldThoughts({
      entries: [
        thought({ key: 'a', text: 'first' }),
        thought({ key: 'b', text: 'second', streaming: true }),
      ],
      visibility: EThinkingVisibility.Keep,
    })

    expect(folded[0]).toMatchObject({ streaming: true, interrupted: false })
  })

  it('carries the interruption of the thought the turn stopped on', () => {
    const folded = foldThoughts({
      entries: [
        thought({ key: 'a', text: 'first' }),
        thought({ key: 'b', text: 'second', interrupted: true }),
      ],
      visibility: EThinkingVisibility.Keep,
    })

    expect(folded[0]).toMatchObject({ interrupted: true })
  })

  it('drops empty thoughts out of the seam rather than opening the block on a blank line', () => {
    const folded = foldThoughts({
      entries: [
        thought({ key: 'a', text: '' }),
        thought({ key: 'b', text: 'second' }),
      ],
      visibility: EThinkingVisibility.Keep,
    })

    expect(shape(folded)).toEqual([[EEntryKind.ModelThought, 'a', 'second']])
  })
})

describe('the thinking visibility setting', () => {
  const entries = [
    thought({ key: 'done', text: 'settled' }),
    said({ key: 'answer', text: 'a burrito' }),
    thought({ key: 'live', text: 'still going', streaming: true }),
  ]

  it('keeps every thought when set to keep', () => {
    expect(shape(foldThoughts({ entries, visibility: EThinkingVisibility.Keep }))).toEqual([
      [EEntryKind.ModelThought, 'done', 'settled'],
      [EEntryKind.ModelSaid, 'answer', 'a burrito'],
      [EEntryKind.ModelThought, 'live', 'still going'],
    ])
  })

  it('keeps only the thought still streaming when set to stream', () => {
    expect(shape(foldThoughts({ entries, visibility: EThinkingVisibility.Stream }))).toEqual([
      [EEntryKind.ModelSaid, 'answer', 'a burrito'],
      [EEntryKind.ModelThought, 'live', 'still going'],
    ])
  })

  it('keeps no thought at all when set to hidden', () => {
    expect(shape(foldThoughts({ entries, visibility: EThinkingVisibility.Hidden }))).toEqual([
      [EEntryKind.ModelSaid, 'answer', 'a burrito'],
    ])
  })

  it('reads an unknown stored value as the shipped setting', () => {
    expect(thinkingVisibilityOf('kept')).toBe(EThinkingVisibility.Keep)
    expect(thinkingVisibilityOf('stream')).toBe(EThinkingVisibility.Stream)
    expect(thinkingVisibilityOf('hidden')).toBe(EThinkingVisibility.Hidden)
  })
})
