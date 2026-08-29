import { describe, expect, it } from 'bun:test'

import { toCallId } from '@dltech/atlas-core'

import { foldThoughts, EThinkingVisibility, thinkingVisibilityOf } from '../thinking-fold'
import { liveToolGroups } from '../tool-groups'
import { EAuthor, EEntryKind, toolsRanEntry, type TranscriptEntry } from '../transcript-model'

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
  heldOpen: false,
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

const toolsRan = (): TranscriptEntry => {
  const live = liveToolGroups([
    { callId: toCallId('call-1'), name: 'bash', input: {}, precededByBlocks: 0 },
  ]).at(0)
  if (live === undefined) throw new Error('a single call makes a single group')

  return toolsRanEntry(live.group)
}

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

  it('holds the trailing thought open under stream while the tools it opened run above it', () => {
    const tools = toolsRan()

    const shown = foldThoughts({
      entries: [tools, thought({ key: 'settled', text: 'weighing it' })],
      visibility: EThinkingVisibility.Stream,
    })

    expect(shape(shown)).toEqual([
      [tools.kind, tools.key, tools.text],
      [EEntryKind.ModelThought, 'settled', 'weighing it'],
    ])
    expect(shown.at(-1)).toMatchObject({ streaming: false, heldOpen: true })
  })

  it('holds it open under stream even when the tool group renders below it', () => {
    const shown = foldThoughts({
      entries: [thought({ key: 'settled', text: 'weighing it' }), toolsRan()],
      visibility: EThinkingVisibility.Stream,
    })

    expect(shown.at(0)).toMatchObject({
      kind: EEntryKind.ModelThought,
      key: 'settled',
      heldOpen: true,
    })
  })

  it('leaves a streaming thought to its own live tail rather than holding it open', () => {
    const shown = foldThoughts({
      entries: [thought({ key: 'live', text: 'still going', streaming: true })],
      visibility: EThinkingVisibility.Stream,
    })

    expect(shown.at(0)).toMatchObject({ streaming: true, heldOpen: false })
  })

  it('drops the trailing thought under stream once the turn closes under it', () => {
    const ended: TranscriptEntry = {
      kind: EEntryKind.TurnEnded,
      author: EAuthor.Model,
      key: 'turn-1',
      text: '',
      durationMs: 1200,
      outputTokens: 40,
      endedAt: '2026-08-28T00:00:00.000Z',
      interrupted: false,
    }

    const shown = foldThoughts({
      entries: [thought({ key: 'settled', text: 'weighing it' }), ended],
      visibility: EThinkingVisibility.Stream,
    })

    expect(shape(shown)).toEqual([[EEntryKind.TurnEnded, 'turn-1', '']])
  })

  it('drops it under stream once the answer lands below the tools it opened', () => {
    const tools = toolsRan()

    const shown = foldThoughts({
      entries: [
        thought({ key: 'settled', text: 'weighing it' }),
        tools,
        said({ key: 'answer', text: 'a burrito' }),
      ],
      visibility: EThinkingVisibility.Stream,
    })

    expect(shape(shown)).toEqual([
      [tools.kind, tools.key, tools.text],
      [EEntryKind.ModelSaid, 'answer', 'a burrito'],
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
