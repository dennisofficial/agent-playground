import { describe, expect, it } from 'bun:test'

import { EExecutionLocation, executionLocationOf } from '../location'

describe('an execution location named as text', () => {
  it('reads the values the column and the settings file hold', () => {
    expect(executionLocationOf('host')).toBe(EExecutionLocation.Host)
    expect(executionLocationOf('docker')).toBe(EExecutionLocation.Docker)
  })

  it('reads nothing into no decision, so an unwritten column stays undecided', () => {
    expect(executionLocationOf(null)).toBeUndefined()
    expect(executionLocationOf(undefined)).toBeUndefined()
    expect(executionLocationOf('')).toBeUndefined()
  })

  it('refuses a value Atlas never wrote rather than guessing at one', () => {
    expect(executionLocationOf('podman')).toBeUndefined()
    expect(executionLocationOf('HOST')).toBeUndefined()
  })
})
