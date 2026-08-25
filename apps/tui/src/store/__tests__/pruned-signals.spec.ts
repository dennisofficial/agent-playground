import { describe, expect, it } from 'bun:test'

import { EStepEnd } from '@dltech/atlas-harness'

import { prunedSignals } from '../in-flight-steps'
import { ended, log, refTo, started, stepOne, stepTwo, textDelta } from './fixture'

describe('pruning settled signals', () => {
  it('keeps the array it was given when nothing can be dropped', () => {
    const signals = [started(stepOne), textDelta({ stepId: stepOne, blockId: 'b1', text: 'hi' })]

    expect(prunedSignals({ signals, events: [] })).toBe(signals)
  })

  it('drops the signals of a step the transcript no longer renders', () => {
    const durable = log([{ type: 'assistant-said', parts: [{ type: 'text', text: 'hi' }] }])
    const reply = durable[0]
    if (reply === undefined) throw new Error('fixture lost its reply')

    const signals = [
      started(stepOne),
      textDelta({ stepId: stepOne, blockId: 'b1', text: 'hi' }),
      ended({ stepId: stepOne, end: EStepEnd.Completed, supersededBy: refTo(reply) }),
      started(stepTwo),
    ]

    expect(prunedSignals({ signals, events: durable })).toEqual([started(stepTwo)])
  })

  it('holds on to a step whose durable event has not arrived yet', () => {
    const durable = log([{ type: 'assistant-said', parts: [{ type: 'text', text: 'hi' }] }])
    const reply = durable[0]
    if (reply === undefined) throw new Error('fixture lost its reply')

    const signals = [
      started(stepOne),
      textDelta({ stepId: stepOne, blockId: 'b1', text: 'hi' }),
      ended({ stepId: stepOne, end: EStepEnd.Completed, supersededBy: refTo(reply) }),
    ]

    expect(prunedSignals({ signals, events: [] })).toBe(signals)
  })
})
