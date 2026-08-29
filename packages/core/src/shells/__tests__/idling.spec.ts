import { describe, expect, it } from 'bun:test'

import { SLEEP_BUDGET_SECONDS, sleptSeconds, waitsBySleeping } from '../idling'

describe('the seconds a command spends asleep', () => {
  it('reads a bare sleep as seconds', () => {
    expect(sleptSeconds('sleep 115')).toBe(115)
  })

  it('reads the suffixes sleep accepts', () => {
    expect(sleptSeconds('sleep 2m')).toBe(120)
    expect(sleptSeconds('sleep 1h')).toBe(3_600)
    expect(sleptSeconds('sleep 1d')).toBe(86_400)
    expect(sleptSeconds('sleep 0.5')).toBe(0.5)
  })

  it('adds up every sleep in a chain', () => {
    expect(sleptSeconds('sleep 20; echo half; sleep 20')).toBe(40)
  })

  it('counts nothing in a command that never sleeps', () => {
    expect(sleptSeconds('bun test')).toBe(0)
  })

  it('does not mistake a longer word for the command', () => {
    expect(sleptSeconds('grep oversleep 30 notes.txt')).toBe(0)
  })
})

describe('telling an idle wait from a short settle', () => {
  it('calls the poll loop that was burning turns a wait', () => {
    expect(waitsBySleeping('sleep 115; echo waited')).toBe(true)
    expect(waitsBySleeping('sleep 90; echo waited')).toBe(true)
  })

  it('leaves a short settle before a real command alone', () => {
    expect(waitsBySleeping('sleep 2 && curl -sf localhost:3000')).toBe(false)
    expect(waitsBySleeping('sleep 5; bun test')).toBe(false)
  })

  it('leaves the budget itself alone and refuses only past it', () => {
    expect(waitsBySleeping(`sleep ${SLEEP_BUDGET_SECONDS}`)).toBe(false)
    expect(waitsBySleeping(`sleep ${SLEEP_BUDGET_SECONDS + 1}`)).toBe(true)
  })

  it('sees a wait split across several short sleeps', () => {
    expect(waitsBySleeping('sleep 20; sleep 20; sleep 20')).toBe(true)
  })
})
