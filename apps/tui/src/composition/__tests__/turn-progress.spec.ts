import type { Chunk } from '@dltech/atlas-core'
import { ETurnStatus, toStepId, EStepEnd, type ChannelSignal } from '@dltech/atlas-harness'
import { describe, expect, it } from 'bun:test'

import { EMPTY_TRANSCRIPT, type TranscriptModel } from '../../store'
import { toCallId, toRunId } from '@dltech/atlas-core'

import {
  clockReadableAt,
  stoppageOf,
  IDLE_PROGRESS,
  transcriptOfTurn,
  turnAdvanced,
  turnInterrupting,
  turnSettled,
  turnStarted,
  type TurnProgress,
} from '../turn-progress'

const STEP = toStepId('branch#1')

const chunk = (held: Chunk): ChannelSignal => ({ type: 'chunk', stepId: STEP, chunk: held })

const started = () => turnStarted({ now: 1_000 })

const absorbing = (signals: readonly ChannelSignal[]): TurnProgress =>
  signals.reduce<TurnProgress>((progress, signal) => turnAdvanced({ progress, signal }), started())

describe('the clock the working line reads', () => {
  it('is idle until a turn is asked for, so the working line stays away', () => {
    expect(IDLE_PROGRESS.clock.startedAt).toBeNull()
    expect(IDLE_PROGRESS.clock.completed).toBeNull()
  })

  it('starts the moment the turn is sent, not when the first token lands', () => {
    expect(started().clock.startedAt).toBe(1_000)
    expect(started().clock.outputTokens).toBe(0)
  })

  it('counts the reply and the thinking as output', () => {
    const progress = absorbing([
      chunk({ type: 'reasoning-start', id: 'r' }),
      chunk({ type: 'reasoning-delta', id: 'r', text: 'a'.repeat(40) }),
      chunk({ type: 'text-start', id: 't' }),
      chunk({ type: 'text-delta', id: 't', text: 'b'.repeat(40) }),
    ])

    expect(progress.characters).toBe(80)
    expect(progress.clock.outputTokens).toBe(20)
  })

  it('counts by total characters rather than accumulating a rounded estimate', () => {
    const oneAtATime = absorbing(
      Array.from({ length: 8 }, () => chunk({ type: 'text-delta', id: 't', text: 'x' })),
    )
    const allAtOnce = absorbing([chunk({ type: 'text-delta', id: 't', text: 'x'.repeat(8) })])

    expect(oneAtATime.clock.outputTokens).toBe(allAtOnce.clock.outputTokens)
  })

  it('ignores signals that carry no output', () => {
    const progress = absorbing([
      { type: 'step-started', stepId: STEP },
      chunk({ type: 'error', message: 'overloaded' }),
      { type: 'step-ended', stepId: STEP, end: EStepEnd.Completed, supersededBy: null },
    ])

    expect(progress.clock.outputTokens).toBe(0)
  })

  it('marks the turn as interrupting without losing the count so far', () => {
    const progress = turnInterrupting(
      absorbing([chunk({ type: 'text-delta', id: 't', text: 'x'.repeat(12) })]),
    )

    expect(progress.clock.interrupting).toBe(true)
    expect(progress.clock.outputTokens).toBe(3)
  })

  it('does not mark an idle clock as interrupting', () => {
    expect(turnInterrupting(IDLE_PROGRESS)).toBe(IDLE_PROGRESS)
  })

  it('settles into what the turn cost, so the line reads "Worked for"', () => {
    const progress = turnSettled({
      progress: absorbing([chunk({ type: 'text-delta', id: 't', text: 'x'.repeat(400) })]),
      now: 93_000,
    })

    expect(progress.clock.startedAt).toBeNull()
    expect(progress.clock.completed).toEqual({ durationMs: 92_000, outputTokens: 100 })
  })

  it('settles a turn that was never started to idle', () => {
    expect(turnSettled({ progress: IDLE_PROGRESS, now: 5 })).toEqual(IDLE_PROGRESS)
  })

  it('never reads earlier than the turn started, so elapsed cannot go negative', () => {
    const clock = started().clock

    expect(clockReadableAt({ now: 500, clock })).toBe(1_000)
    expect(clockReadableAt({ now: 4_000, clock })).toBe(4_000)
  })

  it('leaves the wall clock alone when no turn is in flight', () => {
    expect(clockReadableAt({ now: 500, clock: IDLE_PROGRESS.clock })).toBe(500)
  })
})

const streamingModel: TranscriptModel = {
  entries: [],
  isEmpty: true,
  streaming: true,
  failure: null,
}

describe('what the transcript is shown while a turn is in flight', () => {
  it('reports streaming before the first chunk arrives, so nothing looks hung', () => {
    const model = transcriptOfTurn({ model: EMPTY_TRANSCRIPT, working: true, failure: null })

    expect(model.streaming).toBe(true)
  })

  it('is the store model untouched once the channel agrees', () => {
    expect(transcriptOfTurn({ model: streamingModel, working: true, failure: null })).toBe(
      streamingModel,
    )
    expect(transcriptOfTurn({ model: EMPTY_TRANSCRIPT, working: false, failure: null })).toBe(
      EMPTY_TRANSCRIPT,
    )
  })

  it('surfaces a turn that threw rather than failing a chunk', () => {
    const model = transcriptOfTurn({
      model: EMPTY_TRANSCRIPT,
      working: false,
      failure: 'the credential expired mid-turn',
    })

    expect(model.failure).toEqual({ message: 'the credential expired mid-turn' })
  })

  it('leaves a failure the channel already reported alone', () => {
    const reported: TranscriptModel = {
      ...EMPTY_TRANSCRIPT,
      failure: { message: 'overloaded_error' },
    }

    expect(
      transcriptOfTurn({ model: reported, working: false, failure: 'something else' }).failure,
    ).toEqual({ message: 'overloaded_error' })
  })

  it('names the reason the turn reported when the channel failed without one', () => {
    const unexplained: TranscriptModel = { ...EMPTY_TRANSCRIPT, failure: { message: null } }

    expect(
      transcriptOfTurn({ model: unexplained, working: false, failure: 'overloaded_error' }).failure,
    ).toEqual({ message: 'overloaded_error' })
  })

  it('keeps a failure the channel reported without a reason when nothing else knows one', () => {
    const unexplained: TranscriptModel = { ...EMPTY_TRANSCRIPT, failure: { message: null } }

    expect(transcriptOfTurn({ model: unexplained, working: false, failure: null })).toBe(unexplained)
  })
})

describe('what a turn outcome tells the user', () => {
  const runId = toRunId('run-1')

  it('says nothing about a turn that completed, went idle, or was interrupted', () => {
    expect(stoppageOf({ status: ETurnStatus.Completed, runId })).toBeNull()
    expect(stoppageOf({ status: ETurnStatus.Idle, runId })).toBeNull()
    expect(stoppageOf({ status: ETurnStatus.Interrupted, runId, committed: true })).toBeNull()
    expect(stoppageOf({ status: ETurnStatus.Interrupted, runId, committed: false })).toBeNull()
  })

  it('passes a failure through in the words the loop used', () => {
    expect(stoppageOf({ status: ETurnStatus.Failed, runId, message: 'overloaded_error', cause: undefined })).toBe(
      'overloaded_error',
    )
  })

  it('says what a paused turn is waiting on rather than dropping the pause', () => {
    const said = stoppageOf({
      status: ETurnStatus.Paused,
      runId,
      callId: toCallId('call-1'),
      reason: 'awaiting approval',
    })

    expect(said).toContain('awaiting approval')
  })

  it('names the step ceiling distinctly from a pause, so the two are not debugged as one', () => {
    const exhausted = stoppageOf({ status: ETurnStatus.Exhausted, runId })
    const paused = stoppageOf({
      status: ETurnStatus.Paused,
      runId,
      callId: toCallId('call-1'),
      reason: 'awaiting read',
    })

    expect(exhausted).toContain('step')
    expect(exhausted).not.toBe(paused)
  })
})
