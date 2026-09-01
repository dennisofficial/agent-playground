import { ERetryReason, type Chunk } from '@dltech/atlas-core'
import { ETurnStatus, toStepId, EStepEnd, type ChannelSignal } from '@dltech/atlas-harness'
import { describe, expect, it } from 'bun:test'

import { EMPTY_TRANSCRIPT, type TranscriptModel } from '../../store'
import { toCallId, toRunId } from '@dltech/atlas-core'

import {
  awakeAt,
  clockReadableAt,
  stoppageOf,
  IDLE_PROGRESS,
  transcriptOfTurn,
  turnAdvanced,
  turnInterrupting,
  turnSettled,
  suspensionFrom,
  suspensionTicked,
  turnStarted,
  type Suspension,
  type TurnProgress,
} from '../turn-progress'

const STEP = toStepId('thread#1')

const chunk = (held: Chunk): ChannelSignal => ({ type: 'chunk', stepId: STEP, chunk: held })

const started = () => turnStarted({ now: 1_000 })

const absorbing = (signals: readonly ChannelSignal[]): TurnProgress =>
  signals.reduce<TurnProgress>(
    (progress, signal) => turnAdvanced({ progress, signal, now: 0 }),
    started(),
  )

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

  it('counts the arguments of a tool call, so a long write does not read as a stall', () => {
    const progress = absorbing([
      chunk({ type: 'tool-input-start', callId: toCallId('call-1'), name: 'write_file' }),
      chunk({ type: 'tool-input-delta', callId: toCallId('call-1'), text: 'a'.repeat(400) }),
    ])

    expect(progress.characters).toBe(400)
    expect(progress.clock.outputTokens).toBe(100)
  })

  it('stops calling the turn thinking once the model starts dictating a tool call', () => {
    const progress = absorbing([
      chunk({ type: 'reasoning-start', id: 'r' }),
      chunk({ type: 'reasoning-delta', id: 'r', text: 'mulling' }),
      chunk({ type: 'tool-input-start', callId: toCallId('call-1'), name: 'write_file' }),
    ])

    expect(progress.clock.reasoning).toBe(false)
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

  it('is not thinking until a reasoning block opens', () => {
    expect(started().clock.reasoning).toBe(false)
    expect(absorbing([chunk({ type: 'text-delta', id: 't', text: 'hi' })]).clock.reasoning).toBe(false)
  })

  it('is thinking only while the reasoning block is open', () => {
    const opened = absorbing([chunk({ type: 'reasoning-start', id: 'r' })])
    expect(opened.clock.reasoning).toBe(true)

    const closed = turnAdvanced({
      progress: opened,
      signal: chunk({ type: 'reasoning-end', id: 'r' }),
      now: 0,
    })
    expect(closed.clock.reasoning).toBe(false)
  })

  it('stops thinking when the answer starts, even if the reasoning block never closed', () => {
    const progress = absorbing([
      chunk({ type: 'reasoning-start', id: 'r' }),
      chunk({ type: 'reasoning-delta', id: 'r', text: 'weighing it up' }),
      chunk({ type: 'text-delta', id: 't', text: 'the answer' }),
    ])

    expect(progress.clock.reasoning).toBe(false)
  })

  it('stops thinking when a tool call is what the thought produced', () => {
    const progress = absorbing([
      chunk({ type: 'reasoning-start', id: 'r' }),
      chunk({ type: 'tool-call', callId: toCallId('call-1'), name: 'read', input: {} }),
    ])

    expect(progress.clock.reasoning).toBe(false)
  })

  it('thinks again when a later step opens a second reasoning block', () => {
    const progress = absorbing([
      chunk({ type: 'reasoning-start', id: 'r1' }),
      chunk({ type: 'reasoning-end', id: 'r1' }),
      chunk({ type: 'tool-call', callId: toCallId('call-1'), name: 'read', input: {} }),
      chunk({ type: 'reasoning-start', id: 'r2' }),
    ])

    expect(progress.clock.reasoning).toBe(true)
  })

  it('leaves the progress untouched when a signal changes neither count nor thinking', () => {
    const progress = absorbing([chunk({ type: 'text-delta', id: 't', text: 'hi' })])

    expect(turnAdvanced({ progress, signal: chunk({ type: 'text-end', id: 't' }), now: 0 })).toBe(
      progress,
    )
  })

  it('is no longer thinking once the turn settles', () => {
    const thinking = absorbing([chunk({ type: 'reasoning-start', id: 'r' })])

    expect(turnSettled({ progress: thinking, now: 5_000 }).clock.reasoning).toBe(false)
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
})

describe('a clock that does not count the time the machine was asleep', () => {
  const TICK = 250

  const ticking = (gaps: readonly number[]): Suspension =>
    gaps.reduce(
      (suspension, gap) =>
        suspensionTicked({ suspension, now: suspension.tickedAt + gap, intervalMs: TICK }),
      suspensionFrom({ now: 1_000 }),
    )

  it('reads as wall clock while the ticks keep arriving', () => {
    const suspension = ticking([TICK, TICK, TICK])

    expect(suspension.suspendedMs).toBe(0)
    expect(awakeAt({ suspension, now: 5_000 })).toBe(5_000)
  })

  it('forgives a tick that ran late without calling the process suspended', () => {
    expect(ticking([TICK, 3_000, TICK]).suspendedMs).toBe(0)
  })

  it('drops an hour of closed lid out of the elapsed time it reports', () => {
    const hour = 60 * 60 * 1_000
    const suspension = ticking([TICK, hour, TICK])

    expect(suspension.suspendedMs).toBe(hour - TICK)
    expect(awakeAt({ suspension, now: 1_000 + hour }) - 1_000).toBe(TICK)
  })

  it('keeps the turn that started before the sleep readable, never negative', () => {
    const hour = 60 * 60 * 1_000
    const suspension = ticking([hour])
    const clock = turnStarted({ now: 1_000 }).clock

    const now = clockReadableAt({ clock, now: awakeAt({ suspension, now: 1_000 + hour }) })

    expect(now - 1_000).toBeGreaterThanOrEqual(0)
  })

  it('adds up several sleeps rather than only remembering the last', () => {
    const suspension = ticking([60_000, TICK, 60_000])

    expect(suspension.suspendedMs).toBe(2 * (60_000 - TICK))
  })
})

describe('the clock while a failed step is being retried', () => {
  const retryWaiting = (over: Partial<Extract<ChannelSignal, { type: 'retry-waiting' }>> = {}) =>
    ({
      type: 'retry-waiting',
      attempt: 1,
      maxAttempts: 10,
      delayMs: 4_000,
      reason: ERetryReason.Overloaded,
      ...over,
    }) as ChannelSignal

  it('keeps what went wrong, so the wait can say why it is waiting', () => {
    const progress = turnAdvanced({
      progress: started(),
      signal: retryWaiting({ reason: ERetryReason.RateLimited }),
      now: 5_000,
    })

    expect(progress.clock.retry?.reason).toBe(ERetryReason.RateLimited)
  })

  it('starts a wait the working line can count down', () => {
    const progress = turnAdvanced({ progress: started(), signal: retryWaiting(), now: 5_000 })

    expect(progress.clock.retry).toEqual({
      attempt: 1,
      maxAttempts: 10,
      delayMs: 4_000,
      reason: ERetryReason.Overloaded,
      startedAt: 5_000,
    })
  })

  /**
   * The attempt that failed is thrown away, so its characters must be too — otherwise the token
   * count keeps a stream nobody will ever see.
   */
  it('forgets what the abandoned attempt streamed', () => {
    const streamed = absorbing([chunk({ type: 'text-delta', id: 't', text: 'half an answer' })])

    const progress = turnAdvanced({ progress: streamed, signal: retryWaiting(), now: 5_000 })

    expect(progress.characters).toBe(0)
    expect(progress.clock.outputTokens).toBe(0)
  })

  it('clears the wait once the next attempt opens a step', () => {
    const waiting = turnAdvanced({ progress: started(), signal: retryWaiting(), now: 5_000 })

    const restarted = turnAdvanced({
      progress: waiting,
      signal: { type: 'step-started', stepId: STEP },
      now: 9_000,
    })

    expect(restarted.clock.retry).toBeNull()
  })

  it('clears the wait as soon as the retried attempt streams anything', () => {
    const waiting = turnAdvanced({ progress: started(), signal: retryWaiting(), now: 5_000 })

    const streaming = turnAdvanced({
      progress: waiting,
      signal: chunk({ type: 'text-delta', id: 't', text: 'hello' }),
      now: 9_000,
    })

    expect(streaming.clock.retry).toBeNull()
  })

  it('drops the wait when the operator interrupts', () => {
    const waiting = turnAdvanced({ progress: started(), signal: retryWaiting(), now: 5_000 })

    expect(turnInterrupting(waiting).clock.retry).toBeNull()
  })

  it('leaves no wait behind once the turn settles', () => {
    const waiting = turnAdvanced({ progress: started(), signal: retryWaiting(), now: 5_000 })

    expect(turnSettled({ progress: waiting, now: 9_000 }).clock.retry).toBeNull()
  })
})
