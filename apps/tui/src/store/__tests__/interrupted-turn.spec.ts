import { describe, expect, it } from 'bun:test'

import { EStepEnd } from '@dltech/atlas-harness'

import { deriveTranscript } from '../derive-transcript'
import { EEntryKind } from '../transcript-model'
import { ended, fromTheModel, log, refTo, started, stepOne, stepTwo, textDelta } from './fixture'

describe('an interrupted turn', () => {
  it('renders the durable partial answer as interrupted', () => {
    const events = log([
      { type: 'user-said', text: 'write me an essay' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'It was the best of' }], interrupted: true },
    ])

    const model = deriveTranscript({ events, signals: [] })

    expect(model.entries.map((entry) => [entry.kind, entry.text])).toEqual([
      [EEntryKind.OperatorSaid, 'write me an essay'],
      [EEntryKind.ModelSaid, 'It was the best of'],
    ])
    expect(fromTheModel(model).map((entry) => entry.interrupted)).toEqual([true])
  })

  it('marks the interruption on the last part when thinking preceded the answer', () => {
    const events = log([
      {
        type: 'assistant-said',
        parts: [
          { type: 'reasoning', text: 'planning' },
          { type: 'text', text: 'It was the' },
        ],
        interrupted: true,
      },
    ])

    const interrupted = fromTheModel(deriveTranscript({ events, signals: [] })).map(
      (entry) => entry.interrupted,
    )

    expect(interrupted).toEqual([false, true])
  })

  it('keeps the partial text visible between the interrupt and its durable event', () => {
    const events = log([{ type: 'user-said', text: 'write me an essay' }])
    const durable = log([
      { type: 'user-said', text: 'write me an essay' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'It was the' }], interrupted: true },
    ])
    const reply = durable[1]
    if (reply === undefined) throw new Error('fixture lost its reply')

    const signals = [
      started(stepOne),
      textDelta({ stepId: stepOne, blockId: 'b1', text: 'It was the' }),
      ended({ stepId: stepOne, end: EStepEnd.Interrupted, supersededBy: refTo(reply) }),
    ]

    const held = deriveTranscript({ events, signals })
    const settled = deriveTranscript({ events: durable, signals })

    expect(held.entries.map((entry) => entry.text)).toEqual(['write me an essay', 'It was the'])
    expect(held.streaming).toBe(false)
    expect(fromTheModel(held).map((entry) => entry.interrupted)).toEqual([true])
    expect(settled.entries.map((entry) => entry.text)).toEqual(['write me an essay', 'It was the'])
    expect(fromTheModel(settled).map((entry) => entry.interrupted)).toEqual([true])
  })
})


describe('a step that failed', () => {
  const streamed = [
    started(stepOne),
    textDelta({ stepId: stepOne, blockId: 'b1', text: 'partial' }),
  ]

  it('surfaces the failure rather than an empty reply, and keeps what streamed', () => {
    const signals = [
      ...streamed,
      { type: 'chunk', stepId: stepOne, chunk: { type: 'error', message: 'overloaded' } } as const,
      ended({ stepId: stepOne, end: EStepEnd.Failed, supersededBy: null }),
    ]

    const model = deriveTranscript({ events: [], signals })

    expect(model.failure).toEqual({ message: 'overloaded' })
    expect(model.entries.map((entry) => entry.text)).toEqual(['partial'])
    expect(model.streaming).toBe(false)
  })

  it('reports a failure with no message when nothing said why', () => {
    const signals = [...streamed, ended({ stepId: stepOne, end: EStepEnd.Failed, supersededBy: null })]

    expect(deriveTranscript({ events: [], signals }).failure).toEqual({ message: null })
  })

  it('clears the failure once the next step starts', () => {
    const signals = [
      ...streamed,
      ended({ stepId: stepOne, end: EStepEnd.Failed, supersededBy: null }),
      started(stepTwo),
      textDelta({ stepId: stepTwo, blockId: 'b2', text: 'second try' }),
    ]

    const model = deriveTranscript({ events: [], signals })

    expect(model.failure).toBeNull()
    expect(model.entries.map((entry) => entry.text)).toEqual(['second try'])
  })

  it('does not report a failure for a completed step that committed nothing', () => {
    const signals = [started(stepOne), ended({ stepId: stepOne, end: EStepEnd.Completed, supersededBy: null })]

    expect(deriveTranscript({ events: [], signals }).failure).toBeNull()
  })
})

