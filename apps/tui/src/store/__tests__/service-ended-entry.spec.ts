import { describe, expect, it } from 'bun:test'

import { EKilledBy, EServiceStatus, type Event } from '@dltech/atlas-core'

import { durableEntries } from '../durable-entries'
import { isExpandable } from '../expandable'
import { EEntryKind, type ServiceEndedEntry } from '../transcript-model'
import { log } from './fixture'

const serviceEnded = (over: Record<string, unknown> = {}) =>
  ({
    type: 'service-ended' as const,
    serviceId: 'svc_1',
    command: 'bun run dev',
    description: 'web dev server',
    status: EServiceStatus.Exited,
    exitCode: 0,
    logPath: '/tmp/atlas/services/svc_1.log',
    tail: 'listening on :3000\n',
    ...over,
  })

const onlyServiceEntry = (events: readonly Event[]): ServiceEndedEntry => {
  const entry = durableEntries({ events }).find(
    (candidate): candidate is ServiceEndedEntry => candidate.kind === EEntryKind.ServiceEnded,
  )
  if (entry === undefined) throw new Error('no service entry was projected')
  return entry
}

describe('a service ending in the transcript', () => {
  it('is its own entry rather than something the operator said', () => {
    const entries = durableEntries({ events: log([serviceEnded()]) })

    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe(EEntryKind.ServiceEnded)
  })

  it('names the service by id and description rather than the command that ran', () => {
    expect(onlyServiceEntry(log([serviceEnded()])).text).toBe(
      'Service svc_1 "web dev server" exited cleanly',
    )
  })

  it('falls back to the command when the service was never named', () => {
    expect(onlyServiceEntry(log([serviceEnded({ description: undefined })])).text).toBe(
      'Service svc_1 `bun run dev` exited cleanly',
    )
  })

  it('reads a non-zero exit as the code it died with', () => {
    const entry = onlyServiceEntry(log([serviceEnded({ exitCode: 1 })]))

    expect(entry.text).toBe('Service svc_1 "web dev server" exited with code 1')
    expect(entry.failed).toBe(true)
  })

  it('says the developer was the one who stopped it, and does not read that as a failure', () => {
    const entry = onlyServiceEntry(
      log([serviceEnded({ status: EServiceStatus.Killed, killedBy: EKilledBy.User, exitCode: undefined })]),
    )

    expect(entry.text).toBe('Service svc_1 "web dev server" was stopped by the user')
    expect(entry.failed).toBe(false)
  })

  it('keeps the log tail for the fold rather than putting it on the line', () => {
    const entry = onlyServiceEntry(log([serviceEnded()]))

    expect(entry.text).not.toContain('listening')
    expect(entry.output).toBe('listening on :3000\n')
    expect(isExpandable(entry)).toBe(true)
  })

  it('does not offer a fold when the service printed nothing', () => {
    expect(isExpandable(onlyServiceEntry(log([serviceEnded({ tail: '' })])))).toBe(false)
  })

  it('never folds into the message a human typed beside it', () => {
    const entries = durableEntries({
      events: log([
        { type: 'user-said', text: 'Again' },
        serviceEnded(),
        { type: 'user-said', text: 'go on' },
      ]),
    })

    expect(entries.map((entry) => entry.kind)).toEqual([
      EEntryKind.OperatorSaid,
      EEntryKind.ServiceEnded,
      EEntryKind.OperatorSaid,
    ])
  })
})
