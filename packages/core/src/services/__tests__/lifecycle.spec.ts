import { describe, expect, it } from 'bun:test'

import { EKilledBy } from '../../shells/status'
import { EServiceStatus, serviceEnding, serviceFailed } from '../status'
import { EStopAction, mayStillBeAlive, stopActionFor } from '../lifecycle'

describe('mayStillBeAlive', () => {
  it('treats a running service as alive', () => {
    expect(mayStillBeAlive({ status: EServiceStatus.Running })).toBe(true)
  })

  it('treats a signalled service as alive until the kernel confirms death', () => {
    expect(mayStillBeAlive({ status: EServiceStatus.Killed })).toBe(true)
  })

  it('treats a recorded exit code as confirmed death, whatever the status says', () => {
    expect(mayStillBeAlive({ status: EServiceStatus.Killed, exitCode: 143 })).toBe(false)
    expect(mayStillBeAlive({ status: EServiceStatus.Exited, exitCode: 0 })).toBe(false)
  })

  it('treats an exited status with no code as dead', () => {
    expect(mayStillBeAlive({ status: EServiceStatus.Exited })).toBe(false)
  })
})

describe('stopActionFor', () => {
  it('SIGTERMs a service that has never been stopped', () => {
    expect(
      stopActionFor({ status: EServiceStatus.Running, stopSignalled: false }),
    ).toBe(EStopAction.Term)
  })

  it('SIGKILLs a service that already ignored a stop', () => {
    expect(
      stopActionFor({ status: EServiceStatus.Killed, stopSignalled: true }),
    ).toBe(EStopAction.Kill)
  })

  it('answers in prose without signalling a service confirmed dead', () => {
    expect(
      stopActionFor({ status: EServiceStatus.Exited, exitCode: 0, stopSignalled: false }),
    ).toBe(EStopAction.Gone)
    expect(
      stopActionFor({ status: EServiceStatus.Killed, exitCode: 143, stopSignalled: true }),
    ).toBe(EStopAction.Gone)
  })
})

describe('serviceEnding', () => {
  it('names a failing exit code', () => {
    expect(serviceEnding({ status: EServiceStatus.Exited, exitCode: 1 })).toBe('exited with code 1')
  })

  it('says a clean exit cleanly', () => {
    expect(serviceEnding({ status: EServiceStatus.Exited, exitCode: 0 })).toBe('exited cleanly')
  })

  it('attributes a stop to whoever asked for it', () => {
    expect(serviceEnding({ status: EServiceStatus.Killed, killedBy: EKilledBy.User })).toBe(
      'was stopped by the user',
    )
    expect(serviceEnding({ status: EServiceStatus.Killed, killedBy: EKilledBy.Model })).toBe(
      'was stopped at your request',
    )
    expect(serviceEnding({ status: EServiceStatus.Killed, killedBy: EKilledBy.SessionEnd })).toBe(
      'was stopped because the session was closing',
    )
    expect(serviceEnding({ status: EServiceStatus.Killed })).toBe('was stopped')
  })
})

describe('serviceFailed', () => {
  it('reads a non-zero exit as failure and a stop as none', () => {
    expect(serviceFailed({ status: EServiceStatus.Exited, exitCode: 1 })).toBe(true)
    expect(serviceFailed({ status: EServiceStatus.Exited, exitCode: 0 })).toBe(false)
    expect(serviceFailed({ status: EServiceStatus.Killed, killedBy: EKilledBy.User })).toBe(false)
  })
})
