import { describe, expect, it } from 'bun:test'

import { EExecutionLocation, toThreadId } from '@dltech/atlas-core'

import { createExecutionLocationState } from '../execution-location-state'

describe('the per-thread location record', () => {
  it('answers for a thread it has noted, and has no opinion on one it has not', () => {
    const state = createExecutionLocationState({ initial: EExecutionLocation.Host })
    const thread = toThreadId('thread-1')

    expect(state.of(thread)).toBeUndefined()

    state.note({ threadId: thread, location: EExecutionLocation.Docker })

    expect(state.of(thread)).toBe(EExecutionLocation.Docker)
    expect(state.of(toThreadId('thread-2'))).toBeUndefined()
  })

  it('keeps a thread’s noted location when the current cell moves to another thread’s', () => {
    const state = createExecutionLocationState({ initial: EExecutionLocation.Host })
    const containerized = toThreadId('containerized')

    state.note({ threadId: containerized, location: EExecutionLocation.Docker })
    state.set(EExecutionLocation.Host)

    expect(state.of(containerized)).toBe(EExecutionLocation.Docker)
    expect(state.current()).toBe(EExecutionLocation.Host)
  })
})
