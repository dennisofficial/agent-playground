import { describe, expect, it } from 'bun:test'

import { EStepEnd, type StepSignal } from '@dltech/atlas-harness'

import { liveSteps, stepsOfSignals } from '../in-flight-steps'
import { createStepTracker } from '../step-tracker'
import {
  ended,
  log,
  reasoningDelta,
  refTo,
  started,
  stepOne,
  stepTwo,
  textDelta,
  toolInputDelta,
  toolInputStart,
} from './fixture'

const tracked = (signals: readonly StepSignal[]) => {
  const tracker = createStepTracker()
  for (const signal of signals) tracker.absorb(signal)
  return tracker
}

describe('the step tracker', () => {
  it('lands where the from-scratch fold lands, signal by signal', () => {
    const signals: StepSignal[] = [
      started(stepOne),
      textDelta({ stepId: stepOne, blockId: 'b1', text: 'hello' }),
      reasoningDelta({ stepId: stepOne, blockId: 'r1', text: 'hmm' }),
      textDelta({ stepId: stepOne, blockId: 'b1', text: ' world' }),
      toolInputStart({ stepId: stepOne, callId: 'call-1', name: 'read' }),
      toolInputDelta({ stepId: stepOne, callId: 'call-1', text: '{"path":"a' }),
      started(stepTwo),
      textDelta({ stepId: stepTwo, blockId: 'b2', text: 'next' }),
    ]
    const tracker = createStepTracker()

    for (const [index, signal] of signals.entries()) {
      tracker.absorb(signal)
      expect(tracker.live([])).toEqual(liveSteps({ steps: stepsOfSignals(signals.slice(0, index + 1)), events: [] }))
    }
  })

  it('names the run the reveal gate writes into', () => {
    const tracker = tracked([
      started(stepOne),
      textDelta({ stepId: stepOne, blockId: 'b1', text: 'partial' }),
    ])

    expect(tracker.tailRun([])).toEqual({
      key: `${stepOne}:text:b1`,
      text: 'partial',
    })
  })

  it('has no tail run once the step ends', () => {
    const tracker = tracked([
      started(stepOne),
      textDelta({ stepId: stepOne, blockId: 'b1', text: 'partial' }),
      ended({ stepId: stepOne, end: EStepEnd.Completed, supersededBy: null }),
    ])

    expect(tracker.tailRun([])).toBeNull()
  })

  it('forgets a step once its events are durable', () => {
    const events = log([{ type: 'assistant-said', parts: [{ type: 'text', text: 'done' }] }])
    const reply = events[0]
    if (reply === undefined) throw new Error('fixture lost its reply')

    const tracker = tracked([
      started(stepOne),
      textDelta({ stepId: stepOne, blockId: 'b1', text: 'done' }),
      ended({ stepId: stepOne, end: EStepEnd.Completed, supersededBy: refTo(reply) }),
    ])

    expect(tracker.live(events)).toEqual([])
    expect(tracker.pruneSuperseded(events)).toBe(true)
    expect(tracker.pruneSuperseded(events)).toBe(false)

    tracker.absorb(started(stepTwo))
    tracker.absorb(textDelta({ stepId: stepTwo, blockId: 'b2', text: 'again' }))

    expect(tracker.live(events).map((step) => step.stepId)).toEqual([stepTwo])
  })

  it('parses a dictated input once per arrival, not once per snapshot', () => {
    const tracker = tracked([
      started(stepOne),
      toolInputStart({ stepId: stepOne, callId: 'call-1', name: 'write_file' }),
      toolInputDelta({ stepId: stepOne, callId: 'call-1', text: '{"path":"a","content":"one' }),
    ])

    const first = tracker.live([]).at(0)?.calls.at(0)
    const second = tracker.live([]).at(0)?.calls.at(0)
    expect(first).toBeDefined()
    expect(second?.input).toBe(first?.input)

    tracker.absorb(textDelta({ stepId: stepOne, blockId: 'b1', text: 'unrelated' }))
    expect(tracker.live([]).at(0)?.calls.at(0)?.input).toBe(first?.input)

    tracker.absorb(
      toolInputDelta({ stepId: stepOne, callId: 'call-1', text: ' and two' }),
    )
    const grown = tracker.live([]).at(0)?.calls.at(0)
    expect(grown?.input).toEqual({ path: 'a', content: 'one and two' })
    expect(grown?.input).not.toBe(first?.input)
  })

  it('keeps a trailing failed step until it is dropped on purpose', () => {
    const tracker = tracked([
      started(stepOne),
      textDelta({ stepId: stepOne, blockId: 'b1', text: 'part way' }),
      ended({ stepId: stepOne, end: EStepEnd.Failed, supersededBy: null }),
    ])

    expect(tracker.live([])).toHaveLength(1)
    expect(tracker.pruneSuperseded([])).toBe(false)

    expect(tracker.dropFailedTail([])).toBe(true)
    expect(tracker.live([])).toEqual([])
    expect(tracker.dropFailedTail([])).toBe(false)
  })

  it('stays superseded when the event that replaced it was deleted from the window', () => {
    const [deleted, surviving] = log([
      { type: 'assistant-said', parts: [{ type: 'text', text: 'gone' }] },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'here' }] },
    ])
    if (deleted === undefined || surviving === undefined) throw new Error('fixture lost a reply')

    const tracker = tracked([
      started(stepOne),
      textDelta({ stepId: stepOne, blockId: 'b1', text: 'gone' }),
      ended({ stepId: stepOne, end: EStepEnd.Completed, supersededBy: refTo(deleted) }),
    ])

    expect(tracker.live([surviving])).toEqual([])
    expect(tracker.pruneSuperseded([surviving])).toBe(true)
  })

  it('stays live while the event replacing it has yet to land', () => {
    const [landed, pending] = log([
      { type: 'assistant-said', parts: [{ type: 'text', text: 'earlier' }] },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'just written' }] },
    ])
    if (landed === undefined || pending === undefined) throw new Error('fixture lost a reply')

    const tracker = tracked([
      started(stepOne),
      textDelta({ stepId: stepOne, blockId: 'b1', text: 'just written' }),
      ended({ stepId: stepOne, end: EStepEnd.Completed, supersededBy: refTo(pending) }),
    ])

    expect(tracker.live([landed])).toHaveLength(1)
  })

  it('forgets every step on reset, the way a rewind needs', () => {
    const tracker = tracked([
      started(stepOne),
      textDelta({ stepId: stepOne, blockId: 'b1', text: 'partial' }),
    ])

    expect(tracker.live([])).toHaveLength(1)

    tracker.reset()

    expect(tracker.live([])).toEqual([])
    expect(tracker.tailRun([])).toBeNull()

    tracker.absorb(started(stepTwo))
    tracker.absorb(textDelta({ stepId: stepTwo, blockId: 'b2', text: 'after' }))
    expect(tracker.live([]).map((step) => step.stepId)).toEqual([stepTwo])
  })
})
