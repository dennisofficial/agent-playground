import { afterEach, describe, expect, it } from 'bun:test'

import { EKilledBy } from '@dltech/atlas-core'

import {
  announced,
  closeRegistries,
  job,
  openRegistry,
  settle,
  stillRunningDraft,
  THREAD,
} from './shell-registry-fixture'

afterEach(closeRegistries)

const CHECK_IN_MS = 100

describe('checking in on a background shell that has not ended', () => {
  it('announces a quiet shell once the interval passes, with how long it has run', async () => {
    const { registry, clock } = openRegistry()
    const started = registry.start({ ...job({ command: 'sleep 30' }), checkInMs: CHECK_IN_MS })
    if (!started.ok) throw new Error(started.reason)
    clock.advance(120_000)

    await announced({ registry })
    const drained = registry.drainNotifications({ threadId: THREAD })

    expect(drained).toHaveLength(1)
    expect(stillRunningDraft(drained[0])).toMatchObject({
      type: 'background-shell-still-running',
      shellId: 'bash_1',
      command: 'sleep 30',
      runningForMs: 120_000,
      silentForMs: 120_000,
      checkInMs: CHECK_IN_MS,
      tail: '',
    })
  })

  it('carries what a chatty shell last printed, without consuming what a read would return', async () => {
    const { registry } = openRegistry()
    const started = registry.start({
      ...job({ command: `printf '40 pending no-check\\n'; sleep 30` }),
      checkInMs: CHECK_IN_MS,
    })
    if (!started.ok) throw new Error(started.reason)

    await announced({ registry })
    const drained = registry.drainNotifications({ threadId: THREAD })

    expect(drained).toHaveLength(1)
    expect(stillRunningDraft(drained[0]).tail).toContain('40 pending no-check')

    const read = registry.read({ shellId: started.snapshot.shellId, threadId: THREAD })
    expect(read.ok && read.delta.text).toContain('40 pending no-check')
  })

  it('repeats on the cadence for as long as the shell runs', async () => {
    const { registry } = openRegistry()
    const started = registry.start({ ...job({ command: 'sleep 30' }), checkInMs: CHECK_IN_MS })
    if (!started.ok) throw new Error(started.reason)

    await announced({ registry })
    expect(registry.drainNotifications({ threadId: THREAD })).toHaveLength(1)

    await announced({ registry })
    const second = registry.drainNotifications({ threadId: THREAD })
    expect(second).toHaveLength(1)
    expect(stillRunningDraft(second[0]).shellId).toBe('bash_1')
  })

  it('keeps only the freshest check-in when nobody drains between intervals', async () => {
    const { registry } = openRegistry()
    const started = registry.start({ ...job({ command: 'sleep 30' }), checkInMs: CHECK_IN_MS })
    if (!started.ok) throw new Error(started.reason)

    await Bun.sleep(CHECK_IN_MS * 3 + 150)

    expect(registry.pendingNotices({ threadId: THREAD })).toHaveLength(1)
    expect(registry.drainNotifications({ threadId: THREAD })).toHaveLength(1)
  })

  it('queues no check-in behind the ending of a shell that finished', async () => {
    const { registry } = openRegistry()
    const started = registry.start({ ...job({ command: `echo done` }), checkInMs: CHECK_IN_MS })
    if (!started.ok) throw new Error(started.reason)
    await settle({ registry, shellId: started.snapshot.shellId })
    await announced({ registry })

    await Bun.sleep(CHECK_IN_MS * 2 + 100)

    const drained = registry.drainNotifications({ threadId: THREAD })
    expect(drained.some((draft) => draft.type === 'background-shell-ended')).toBe(true)
    expect(drained.some((draft) => draft.type === 'background-shell-still-running')).toBe(false)
  })

  it('checks in no more once the shell is killed', async () => {
    const { registry } = openRegistry()
    const started = registry.start({ ...job({ command: 'sleep 30' }), checkInMs: CHECK_IN_MS })
    if (!started.ok) throw new Error(started.reason)

    registry.kill({ shellId: started.snapshot.shellId, by: EKilledBy.User, threadId: THREAD })
    await settle({ registry, shellId: started.snapshot.shellId })
    await announced({ registry })
    registry.drainNotifications({ threadId: THREAD })

    await Bun.sleep(CHECK_IN_MS * 2 + 100)

    expect(registry.pendingNotices({ threadId: THREAD })).toEqual([])
  })
})
