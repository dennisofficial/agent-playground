import { describe, expect, it } from 'bun:test'

import { SLEEP_BUDGET_SECONDS, idledSeconds, sleptSeconds, waitsBySleeping } from '../idling'

const UNBOUNDED_MS = 600_000

const waits = (command: string, timeoutMs = UNBOUNDED_MS): boolean =>
  waitsBySleeping({ command, timeoutMs })

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
    expect(waits('sleep 115; echo waited')).toBe(true)
    expect(waits('sleep 90; echo waited')).toBe(true)
  })

  it('leaves a short settle before a real command alone', () => {
    expect(waits('sleep 2 && curl -sf localhost:3000')).toBe(false)
    expect(waits('sleep 5; bun test')).toBe(false)
  })

  it('leaves the budget itself alone and refuses only past it', () => {
    expect(waits(`sleep ${SLEEP_BUDGET_SECONDS}`)).toBe(false)
    expect(waits(`sleep ${SLEEP_BUDGET_SECONDS + 1}`)).toBe(true)
  })

  it('sees a wait split across several short sleeps', () => {
    expect(waits('sleep 20; sleep 20; sleep 20')).toBe(true)
  })
})

describe('a timeout the caller set caps what the command can idle away', () => {
  const BRIEF_MS = 300

  it('allows a long sleep the timeout will cut short well inside the budget', () => {
    expect(waits('(sleep 2; touch marker) & echo working; sleep 30', BRIEF_MS)).toBe(false)
  })

  it('still refuses when the timeout leaves room to idle past the budget', () => {
    expect(waits(`sleep ${SLEEP_BUDGET_SECONDS * 4}`, UNBOUNDED_MS)).toBe(true)
  })

  it('measures the idle as the shorter of the sleeping and the timeout', () => {
    expect(idledSeconds({ command: 'sleep 120', timeoutMs: 5_000 })).toBe(5)
    expect(idledSeconds({ command: 'sleep 3', timeoutMs: UNBOUNDED_MS })).toBe(3)
  })

  it('leaves the budget itself alone when the timeout lands exactly on it', () => {
    expect(waits('sleep 600', SLEEP_BUDGET_SECONDS * 1_000)).toBe(false)
  })
})
