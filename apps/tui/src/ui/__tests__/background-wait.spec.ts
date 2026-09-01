import { describe, expect, it } from 'bun:test'

import { backgroundWaitLabel, isWaiting, NOTHING_IN_BACKGROUND } from '../background-wait'

describe('what the transcript says while the main agent is idle', () => {
  it('says nothing when nothing is left running', () => {
    expect(backgroundWaitLabel({ work: NOTHING_IN_BACKGROUND })).toBeNull()
  })

  it('counts agents alone', () => {
    expect(backgroundWaitLabel({ work: { agents: 2, shells: 0 } })).toBe(
      'Waiting for 2 background agents to finish',
    )
  })

  it('counts shells alone', () => {
    expect(backgroundWaitLabel({ work: { agents: 0, shells: 3 } })).toBe(
      'Waiting for 3 shells to finish',
    )
  })

  it('joins the two kinds when both are running', () => {
    expect(backgroundWaitLabel({ work: { agents: 2, shells: 1 } })).toBe(
      'Waiting for 2 background agents and 1 shell to finish',
    )
  })

  it('drops the plural on a single one of either', () => {
    expect(backgroundWaitLabel({ work: { agents: 1, shells: 1 } })).toBe(
      'Waiting for 1 background agent and 1 shell to finish',
    )
  })
})

describe('how long the wait itself has run', () => {
  it('appends the elapsed reading when one is on offer', () => {
    expect(backgroundWaitLabel({ work: { agents: 0, shells: 1 }, waitedMs: 64_000 })).toBe(
      'Waiting for 1 shell to finish · 1m 4s',
    )
  })

  it('leaves the sentence bare when nothing has been timed yet', () => {
    expect(backgroundWaitLabel({ work: { agents: 0, shells: 1 } })).toBe(
      'Waiting for 1 shell to finish',
    )
  })

  it('is only waiting when something is actually outstanding', () => {
    expect(isWaiting(NOTHING_IN_BACKGROUND)).toBe(false)
    expect(isWaiting({ agents: 0, shells: 1 })).toBe(true)
    expect(isWaiting({ agents: 1, shells: 0 })).toBe(true)
  })
})
