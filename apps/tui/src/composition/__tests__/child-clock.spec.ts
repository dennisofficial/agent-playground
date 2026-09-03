import { describe, expect, it } from 'bun:test'

import { EStepEnd, toStepId, type ChannelSignal } from '@dltech/atlas-harness'

import { IDLE_TURN } from '../../ui/components/transcript'
import { IDLE_PROGRESS, turnObserved, turnOfChild, turnStarted } from '../turn-progress'

const STEP = toStepId('thread_child#1')

const started: ChannelSignal = { type: 'step-started', stepId: STEP }

const ended: ChannelSignal = {
  type: 'step-ended',
  stepId: STEP,
  end: EStepEnd.Completed,
  supersededBy: null,
}

const AT = 10_000

describe('a turn nobody in this session drove', () => {
  it('opens its clock on the first step, because there was no keystroke to stamp it', () => {
    const observed = turnObserved({ progress: IDLE_PROGRESS, signal: started, now: AT })

    expect(observed.clock.startedAt).toBe(AT)
  })

  it('leaves a clock somebody already stamped alone, so a driven turn keeps its own start', () => {
    const driven = turnStarted({ now: 5_000 })
    const observed = turnObserved({ progress: driven, signal: started, now: AT })

    expect(observed.clock.startedAt).toBe(5_000)
  })

  it('does not open a clock on anything but a step starting', () => {
    const observed = turnObserved({ progress: IDLE_PROGRESS, signal: ended, now: AT })

    expect(observed.clock.startedAt).toBeNull()
  })
})

describe("a child's clock", () => {
  it('reads the step the supervisor stamped rather than whatever the fold saw', () => {
    const observed = turnObserved({ progress: IDLE_PROGRESS, signal: started, now: AT })
    const turn = turnOfChild({
      observed: observed.clock,
      running: true,
      steppingSince: new Date(4_000).toISOString(),
    })

    expect(turn.startedAt).toBe(4_000)
  })

  it('survives the view being closed and reopened, because the stamp is not held here', () => {
    const reopened = turnOfChild({
      observed: IDLE_TURN,
      running: true,
      steppingSince: new Date(4_000).toISOString(),
    })

    expect(reopened.startedAt).toBe(4_000)
  })

  it('falls back to the fold when the roster carries no stamp', () => {
    const observed = turnObserved({ progress: IDLE_PROGRESS, signal: started, now: AT })
    const turn = turnOfChild({ observed: observed.clock, running: true, steppingSince: null })

    expect(turn.startedAt).toBe(AT)
  })

  it('is idle once the child settles, so a finished log carries no working line', () => {
    const observed = turnObserved({ progress: IDLE_PROGRESS, signal: started, now: AT })
    const turn = turnOfChild({
      observed: observed.clock,
      running: false,
      steppingSince: new Date(4_000).toISOString(),
    })

    expect(turn.startedAt).toBeNull()
  })

  it('ignores a stamp that is not a date rather than reading it as 1970', () => {
    const turn = turnOfChild({
      observed: IDLE_TURN,
      running: true,
      steppingSince: 'not a date',
    })

    expect(turn.startedAt).toBeNull()
  })
})
