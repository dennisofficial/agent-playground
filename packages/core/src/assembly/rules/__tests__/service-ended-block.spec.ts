import { describe, expect, it } from 'bun:test'

import { EServiceStatus } from '../../../services/status'
import { EKilledBy } from '../../../shells/status'
import { serviceEndedBlock } from '../service-ended-block'
import { runningServicesReminder } from '../running-services-block'

const ended = (over: Partial<Parameters<typeof serviceEndedBlock>[0]> = {}) =>
  ({
    id: 'evt_1',
    seq: 1,
    threadId: 'br_1',
    runId: 'run_1',
    depth: 0,
    at: '2026-09-02T12:00:00.000Z',
    type: 'service-ended',
    serviceId: 'svc_1',
    command: 'bun run dev',
    status: EServiceStatus.Exited,
    exitCode: 1,
    logPath: '/home/dev/.atlas/services/svc_1.log',
    tail: 'error: EADDRINUSE\n',
    ...over,
  }) as Parameters<typeof serviceEndedBlock>[0]

describe('handing an ended service to the model', () => {
  it('names the service, how it ended, and where the rest of the log is', () => {
    const block = serviceEndedBlock(ended({ description: 'web dev server' }))

    expect(block).toContain('svc_1')
    expect(block).toContain('"web dev server"')
    expect(block).toContain('`bun run dev`')
    expect(block).toContain('exited with code 1')
    expect(block).toContain('/home/dev/.atlas/services/svc_1.log')
    expect(block).toContain('error: EADDRINUSE')
  })

  it('says it was infrastructure, not work the model was waiting on', () => {
    expect(serviceEndedBlock(ended())).toContain('not work you were waiting on')
  })

  it('admits an empty log rather than printing nothing silently', () => {
    expect(serviceEndedBlock(ended({ tail: '' }))).toContain('Its log is empty.')
  })

  it('says the user was the one who stopped it, and that nothing is wrong', () => {
    const block = serviceEndedBlock(
      ended({ status: EServiceStatus.Killed, killedBy: EKilledBy.User, exitCode: undefined }),
    )

    expect(block).toContain('was stopped by the user')
    expect(block).toContain('do not restart it')
  })

  it('tells the model when the stop was its own, so it does not read it as interference', () => {
    const block = serviceEndedBlock(
      ended({ status: EServiceStatus.Killed, killedBy: EKilledBy.Model, exitCode: undefined }),
    )

    expect(block).toContain('was stopped at your request')
    expect(block).not.toContain('do not restart it')
  })

  it('wraps the block so the model can tell it from something a human typed', () => {
    const block = serviceEndedBlock(ended())

    expect(block.startsWith('<service-ended>')).toBe(true)
    expect(block.endsWith('</service-ended>')).toBe(true)
  })
})

describe('the running-services reminder', () => {
  const services = [
    {
      serviceId: 'svc_1',
      command: 'bun run dev',
      description: 'web dev server',
      logPath: '/home/dev/.atlas/services/svc_1.log',
    },
  ]

  it('names each service and its log, and forbids polling', () => {
    const reminder = runningServicesReminder(services)

    expect(reminder).toContain('svc_1')
    expect(reminder).toContain('"web dev server"')
    expect(reminder).toContain('log: /home/dev/.atlas/services/svc_1.log')
    expect(reminder).toContain('no completion is coming')
    expect(reminder).toContain('if one dies you will be told')
    expect(reminder).toContain('never by polling service_list')
    expect(reminder).toContain('service_stop({ id })')
  })
})
