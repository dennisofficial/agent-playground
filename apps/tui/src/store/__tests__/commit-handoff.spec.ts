import { describe, expect, it } from 'bun:test'

import { EStepEnd } from '@dltech/atlas-harness'

import { deriveTranscript } from '../derive-transcript'
import { EEntryKind } from '../transcript-model'
import { ended, fromTheModel, log, reasoningDelta, refTo, started, stepOne, textDelta } from './fixture'

describe('the commit handoff', () => {
  const question = log([{ type: 'user-said', text: 'hello' }])
  const durable = log([
    { type: 'user-said', text: 'hello' },
    { type: 'assistant-said', parts: [{ type: 'text', text: 'hi there' }] },
  ])
  const reply = durable[1]

  const streamed = [
    started(stepOne),
    textDelta({ stepId: stepOne, blockId: 'b1', text: 'hi ' }),
    textDelta({ stepId: stepOne, blockId: 'b1', text: 'there' }),
  ]

  const answers = (model: ReturnType<typeof deriveTranscript>) =>
    model.entries.filter((entry) => entry.kind === EEntryKind.ModelSaid).map((entry) => entry.text)

  it('shows the streamed text exactly once while the step is still open', () => {
    expect(answers(deriveTranscript({ events: question, signals: streamed }))).toEqual(['hi there'])
  })

  it('shows the text exactly once after the step ends, before the durable event is held', () => {
    if (reply === undefined) throw new Error('fixture lost its reply')
    const signals = [...streamed, ended({ stepId: stepOne, end: EStepEnd.Completed, supersededBy: refTo(reply) })]

    expect(answers(deriveTranscript({ events: question, signals }))).toEqual(['hi there'])
  })

  it('shows the text exactly once once the durable event supersedes the deltas', () => {
    if (reply === undefined) throw new Error('fixture lost its reply')
    const signals = [...streamed, ended({ stepId: stepOne, end: EStepEnd.Completed, supersededBy: refTo(reply) })]

    expect(answers(deriveTranscript({ events: durable, signals }))).toEqual(['hi there'])
  })

  it('never duplicates and never flickers to empty across the whole handoff', () => {
    if (reply === undefined) throw new Error('fixture lost its reply')
    const endSignal = ended({ stepId: stepOne, end: EStepEnd.Completed, supersededBy: refTo(reply) })

    const frames = [
      { events: question, signals: streamed },
      { events: question, signals: [...streamed, endSignal] },
      { events: durable, signals: [...streamed, endSignal] },
      { events: durable, signals: [] },
    ]

    expect(frames.map((frame) => answers(deriveTranscript(frame)))).toEqual([
      ['hi there'],
      ['hi there'],
      ['hi there'],
      ['hi there'],
    ])
  })

  it('drops the deltas with nothing replacing them when the step committed nothing durable', () => {
    const signals = [...streamed, ended({ stepId: stepOne, end: EStepEnd.Completed, supersededBy: null })]
    const model = deriveTranscript({ events: question, signals })

    expect(answers(model)).toEqual([])
    expect(model.streaming).toBe(false)
  })
})


describe('a step that completes with deltas still queued', () => {
  const durable = log([
    { type: 'user-said', text: 'explain' },
    {
      type: 'assistant-said',
      parts: [
        { type: 'reasoning', text: 'weighing it up' },
        { type: 'text', text: 'because of X' },
      ],
    },
  ])
  const question = durable.slice(0, 1)
  const reply = durable[1]

  it('keeps every queued block exactly once, then hands all of them over together', () => {
    if (reply === undefined) throw new Error('fixture lost its reply')

    const signals = [
      started(stepOne),
      reasoningDelta({ stepId: stepOne, blockId: 'r1', text: 'weighing ' }),
      reasoningDelta({ stepId: stepOne, blockId: 'r1', text: 'it up' }),
      textDelta({ stepId: stepOne, blockId: 't1', text: 'because of X' }),
      ended({ stepId: stepOne, end: EStepEnd.Completed, supersededBy: refTo(reply) }),
    ]

    const queued = deriveTranscript({ events: question, signals })
    const handedOver = deriveTranscript({ events: durable, signals })

    expect(queued.entries.map((entry) => [entry.kind, entry.text])).toEqual([
      [EEntryKind.OperatorSaid, 'explain'],
      [EEntryKind.ModelThought, 'weighing it up'],
      [EEntryKind.ModelSaid, 'because of X'],
    ])
    expect(handedOver.entries.map((entry) => [entry.kind, entry.text])).toEqual(
      queued.entries.map((entry) => [entry.kind, entry.text]),
    )
    expect(fromTheModel(handedOver).every((entry) => !entry.streaming)).toBe(true)
  })
})
