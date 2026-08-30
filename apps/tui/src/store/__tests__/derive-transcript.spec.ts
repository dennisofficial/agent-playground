import { describe, expect, it } from 'bun:test'

import { EStepEnd, type StepId, type StepSignal } from '@dltech/atlas-harness'

import { deriveTranscript } from '../derive-transcript'
import { EThinkingVisibility } from '../thinking-fold'
import { settled } from '../tool-runs'
import { EAuthor, EEntryKind } from '../transcript-model'
import {
  ended,
  fromTheModel,
  log,
  reasoningDelta,
  refTo,
  started,
  stepOne,
  stepTwo,
  textDelta,
} from './fixture'
import { called, callId, result } from './tool-fixture'

describe('an empty thread', () => {
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

  it('settles the thinking the moment the answer starts arriving after it', () => {
    const thinkingAlone = deriveTranscript({
      events: [],
      signals: [started(stepOne), reasoningDelta({ stepId: stepOne, blockId: 'r1', text: 'hmm' })],
    })
    expect(fromTheModel(thinkingAlone).at(-1)?.streaming).toBe(true)

    const answered = deriveTranscript({
      events: [],
      signals: [
        started(stepOne),
        reasoningDelta({ stepId: stepOne, blockId: 'r1', text: 'hmm' }),
        textDelta({ stepId: stepOne, blockId: 't1', text: 'yes' }),
      ],
    })

    expect(fromTheModel(answered).map((entry) => entry.streaming)).toEqual([false, true])
    expect(answered.streaming).toBe(true)
  })

  it('is streaming from the moment a step starts, before any delta arrives', () => {
    const model = deriveTranscript({ events: [], signals: [started(stepOne)] })

    expect(model.streaming).toBe(true)
    expect(model.entries).toEqual([])
    expect(model.isEmpty).toBe(true)
  })
})

const toolCall = (args: { stepId: StepId; n: number; name: string }): StepSignal => ({
  type: 'chunk',
  stepId: args.stepId,
  chunk: { type: 'tool-call', callId: callId(args.n), name: args.name, input: {} },
})

const shapeOf = (model: ReturnType<typeof deriveTranscript>) =>
  model.entries.map((entry) => [entry.kind, entry.text] as const)

describe('tool calls in the transcript', () => {
  it('stands the group where it ran, between the sentence before it and the one after', () => {
    const events = log([
      { type: 'user-said', text: 'find the loop' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'Looking.' }] },
      called({ n: 1, name: 'read' }),
      result({ n: 1, name: 'read' }),
      called({ n: 2, name: 'read' }),
      result({ n: 2, name: 'read' }),
      { type: 'assistant-said', parts: [{ type: 'text', text: 'It lives in run-turn.' }] },
    ])

    expect(shapeOf(deriveTranscript({ events, signals: [] }))).toEqual([
      [EEntryKind.OperatorSaid, 'find the loop'],
      [EEntryKind.ModelSaid, 'Looking.'],
      [EEntryKind.ToolsRan, 'Read 2 files'],
      [EEntryKind.ModelSaid, 'It lives in run-turn.'],
    ])
  })

  it('draws one entry for the group, not one per call', () => {
    const events = log([
      called({ n: 1, name: 'read' }),
      called({ n: 2, name: 'read' }),
      called({ n: 3, name: 'read' }),
      result({ n: 1, name: 'read' }),
      result({ n: 2, name: 'read' }),
      result({ n: 3, name: 'read' }),
    ])

    const entries = deriveTranscript({ events, signals: [] }).entries
    expect(entries.length).toBe(1)
    expect(entries[0]?.kind).toBe(EEntryKind.ToolsRan)
  })

  it('keys the entry off the call that opened the group, so every entry stays distinct', () => {
    const events = log([
      called({ n: 1, name: 'read' }),
      called({ n: 2, name: 'bash' }),
      called({ n: 3, name: 'read' }),
    ])

    const keys = deriveTranscript({ events, signals: [] }).entries.map((entry) => entry.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('a tool call that has only been streamed', () => {
  it('renders before any durable event exists for it', () => {
    const signals = [
      started(stepOne),
      textDelta({ stepId: stepOne, blockId: 't1', text: 'let me look' }),
      toolCall({ stepId: stepOne, n: 1, name: 'read' }),
    ]

    const model = deriveTranscript({ events: [], signals })

    expect(shapeOf(model)).toEqual([
      [EEntryKind.ModelSaid, 'let me look'],
      [EEntryKind.ToolsRan, 'Working…'],
    ])
    expect(fromTheModel(model).at(-1)?.streaming).toBe(true)
  })

  it('sits after the text that streamed before it and before the text that followed', () => {
    const signals = [
      started(stepOne),
      textDelta({ stepId: stepOne, blockId: 't1', text: 'first' }),
      toolCall({ stepId: stepOne, n: 1, name: 'read' }),
      textDelta({ stepId: stepOne, blockId: 't2', text: 'second' }),
      toolCall({ stepId: stepOne, n: 2, name: 'read' }),
    ]

    expect(shapeOf(deriveTranscript({ events: [], signals }))).toEqual([
      [EEntryKind.ModelSaid, 'first'],
      [EEntryKind.ToolsRan, 'Working…'],
      [EEntryKind.ModelSaid, 'second'],
      [EEntryKind.ToolsRan, 'Working…'],
    ])
  })

  it('absorbs a repeated chunk for the same call without counting it twice', () => {
    const signals = [
      started(stepOne),
      toolCall({ stepId: stepOne, n: 1, name: 'read' }),
      toolCall({ stepId: stepOne, n: 1, name: 'read' }),
    ]

    const entries = deriveTranscript({ events: [], signals }).entries
    expect(entries.length).toBe(1)
    expect(entries[0]?.text).toBe('Working…')
  })

  it('hands over to the durable event without drawing the group twice', () => {
    const durable = log([
      { type: 'assistant-said', parts: [{ type: 'text', text: 'let me look' }] },
      called({ n: 1, name: 'read' }),
    ])
    const reply = durable[0]
    if (reply === undefined) throw new Error('fixture lost its reply')

    const streamed = [
      started(stepOne),
      textDelta({ stepId: stepOne, blockId: 't1', text: 'let me look' }),
      toolCall({ stepId: stepOne, n: 1, name: 'read' }),
    ]
    const endSignal = ended({ stepId: stepOne, end: EStepEnd.Completed, supersededBy: refTo(reply) })

    const frames = [
      { events: [], signals: streamed },
      { events: [], signals: [...streamed, endSignal] },
      { events: durable, signals: [...streamed, endSignal] },
      { events: durable, signals: [] },
    ]

    const once: (readonly [EEntryKind, string])[] = [
      [EEntryKind.ModelSaid, 'let me look'],
      [EEntryKind.ToolsRan, 'Working…'],
    ]

    expect(frames.map((frame) => shapeOf(deriveTranscript(frame)))).toEqual([
      once,
      once,
      once,
      once,
    ])
  })

  it('drops the streamed group with nothing replacing it when the step committed nothing', () => {
    const signals = [
      started(stepOne),
      toolCall({ stepId: stepOne, n: 1, name: 'read' }),
      ended({ stepId: stepOne, end: EStepEnd.Completed, supersededBy: null }),
    ]

    expect(deriveTranscript({ events: [], signals }).entries).toEqual([])
  })

  it('keeps the same key across the handoff, so the row is never remounted', () => {
    const durable = log([called({ n: 1, name: 'read' })])
    const streamed = [started(stepOne), toolCall({ stepId: stepOne, n: 1, name: 'read' })]

    const live = deriveTranscript({ events: [], signals: streamed }).entries[0]
    const held = deriveTranscript({ events: durable, signals: [] }).entries[0]

    expect(live?.key).toBe(held?.key)
    expect(held?.kind).toBe(EEntryKind.ToolsRan)
  })

  it('is still live once the durable call exists but its result does not', () => {
    const events = log([called({ n: 1, name: 'bash' })])
    const entry = deriveTranscript({ events, signals: [] }).entries[0]

    expect(entry?.kind).toBe(EEntryKind.ToolsRan)
    if (entry?.kind !== EEntryKind.ToolsRan) throw new Error('the group was not projected')
    expect(entry.run.calls.every((call) => !settled(call))).toBe(true)
    expect(entry.streaming).toBe(true)
  })
})

describe('reasoning across steps', () => {
  const events = log([
    { type: 'assistant-said', parts: [{ type: 'reasoning', text: 'weighing it up' }] },
    { type: 'assistant-said', parts: [{ type: 'reasoning', text: 'still weighing' }] },
    { type: 'assistant-said', parts: [{ type: 'text', text: 'a burrito' }] },
  ])

  it('stands one thinking block where two steps thought back to back', () => {
    expect(shapeOf(deriveTranscript({ events, signals: [] }))).toEqual([
      [EEntryKind.ModelThought, 'weighing it up\n\nstill weighing'],
      [EEntryKind.ModelSaid, 'a burrito'],
    ])
  })

  it('folds a durable thought into the one still streaming after it', () => {
    const model = deriveTranscript({
      events: log([
        { type: 'assistant-said', parts: [{ type: 'reasoning', text: 'weighing it up' }] },
      ]),
      signals: [started(stepTwo), reasoningDelta({ stepId: stepTwo, blockId: 'r1', text: 'more' })],
    })

    expect(shapeOf(model)).toEqual([[EEntryKind.ModelThought, 'weighing it up\n\nmore']])
    expect(fromTheModel(model).at(-1)?.streaming).toBe(true)
  })

  it('drops settled thinking but keeps the live tail when set to stream', () => {
    const model = deriveTranscript({
      events,
      signals: [started(stepTwo), reasoningDelta({ stepId: stepTwo, blockId: 'r1', text: 'more' })],
      thinking: EThinkingVisibility.Stream,
    })

    expect(shapeOf(model)).toEqual([
      [EEntryKind.ModelSaid, 'a burrito'],
      [EEntryKind.ModelThought, 'more'],
    ])
  })

  it('drops thinking entirely when set to hidden, live tail included', () => {
    const model = deriveTranscript({
      events,
      signals: [started(stepTwo), reasoningDelta({ stepId: stepTwo, blockId: 'r1', text: 'more' })],
      thinking: EThinkingVisibility.Hidden,
    })

    expect(shapeOf(model)).toEqual([[EEntryKind.ModelSaid, 'a burrito']])
    expect(model.streaming).toBe(true)
  })
})

describe('a tool group opened by the step that was thinking', () => {
  const events = log([
    { type: 'user-said', text: 'read the architecture doc' },
    { type: 'assistant-said', parts: [{ type: 'reasoning', text: 'weighing it up' }] },
    called({ n: 1, name: 'bash' }),
    result({ n: 1, name: 'bash' }),
  ])

  const stillReading: readonly StepSignal[] = [
    started(stepTwo),
    reasoningDelta({ stepId: stepTwo, blockId: 'r1', text: 'let me read the doc' }),
    toolCall({ stepId: stepTwo, n: 2, name: 'read' }),
  ]

  it('stands the group above the thought instead of nesting it underneath', () => {
    const model = deriveTranscript({ events, signals: stillReading })

    expect(fromTheModel(model).map((entry) => entry.kind)).toEqual([
      EEntryKind.ToolsRan,
      EEntryKind.ToolsRan,
      EEntryKind.ModelThought,
    ])
  })

  it('leaves the thought last under stream, so the setting keeps showing it', () => {
    const model = deriveTranscript({
      events,
      signals: stillReading,
      thinking: EThinkingVisibility.Stream,
    })

    expect(model.entries.at(-1)?.kind).toBe(EEntryKind.ModelThought)
    expect(model.entries.at(-1)?.text).toBe('weighing it up\n\nlet me read the doc')
  })
})
