import { describe, expect, it } from 'bun:test'

import { EKilledBy, EShellStatus, shellEnding, shellFailed } from '../status'

const killedBy = (by: EKilledBy): string =>
  shellEnding({ status: EShellStatus.Killed, killedBy: by })

const exited = (exitCode: number): string => shellEnding({ status: EShellStatus.Exited, exitCode })

describe('the sentence a shell ends on', () => {
  it('names a timeout as outliving the timeout', () => {
    expect(killedBy(EKilledBy.Timeout)).toBe('was killed for outliving its timeout')
  })

  it('names who killed the shell when the harness recorded it', () => {
    expect(killedBy(EKilledBy.User)).toBe('was killed by the user')
    expect(killedBy(EKilledBy.Model)).toBe('was killed at your request')
    expect(killedBy(EKilledBy.SessionEnd)).toBe('was killed because the session was closing')
  })

  it('says only that it was killed when nobody was recorded', () => {
    expect(killedBy(EKilledBy.Unrecorded)).toBe('was killed')
    expect(shellEnding({ status: EShellStatus.Killed })).toBe('was killed')
  })

  it('says how much a shell printed before it overflowed', () => {
    const ending = { status: EShellStatus.Overflowed, totalCharacters: 30_000 }
    expect(shellEnding(ending)).toBe('was killed for printing more than 30000 characters')
  })

  it('reads an exit code back as success or failure', () => {
    expect(exited(0)).toBe('finished successfully')
    expect(exited(1)).toBe('failed with exit code 1')
  })

  it('claims nothing about an exit code the harness never saw', () => {
    expect(shellEnding({ status: EShellStatus.Exited })).toBe('has finished')
  })
})

describe('whether an ending counts as a failure', () => {
  it('counts a non-zero exit and an overflow as failures', () => {
    expect(shellFailed({ status: EShellStatus.Exited, exitCode: 1 })).toBe(true)
    expect(shellFailed({ status: EShellStatus.Overflowed, totalCharacters: 30_000 })).toBe(true)
  })

  it('counts a clean exit and an unread exit code as not failing', () => {
    expect(shellFailed({ status: EShellStatus.Exited, exitCode: 0 })).toBe(false)
    expect(shellFailed({ status: EShellStatus.Exited })).toBe(false)
  })

  it('counts a kill as an ending rather than a failure, however it was killed', () => {
    expect(shellFailed({ status: EShellStatus.Killed, killedBy: EKilledBy.Timeout })).toBe(false)
    expect(shellFailed({ status: EShellStatus.Killed, killedBy: EKilledBy.User })).toBe(false)
  })
})
