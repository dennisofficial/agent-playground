import { afterEach, describe, expect, it } from 'bun:test'

import { EShellStatus } from '../background-shell'
import { closeRegistries, job, openRegistry, settle, THREAD } from './shell-registry-fixture'

afterEach(closeRegistries)

describe('shell registry versioning', () => {
  it('publishes a start to subscribers and raises the version', async () => {
    const { registry } = openRegistry()
    const seen: number[] = []
    registry.subscribe(() => seen.push(registry.version()))

    const started = registry.start(job({ command: 'echo done' }))
    if (!started.ok) throw new Error(started.reason)
    await Bun.sleep(0)

    expect(registry.version()).toBe(1)
    expect(seen).toEqual([1])

    await settle({ registry, shellId: started.snapshot.shellId })
  })

  it('publishes an exit when the process is reaped', async () => {
    const { registry } = openRegistry()
    const started = registry.start(job({ command: 'echo done' }))
    if (!started.ok) throw new Error(started.reason)

    let exits = 0
    registry.subscribe(() => {
      const snapshot = registry
        .list({ threadId: THREAD })
        .find((entry) => entry.shellId === started.snapshot.shellId)
      if (snapshot?.status === EShellStatus.Exited) exits += 1
    })

    await settle({ registry, shellId: started.snapshot.shellId })
    await Bun.sleep(0)

    expect(exits).toBeGreaterThanOrEqual(1)
  })

  it('coalesces output into throttled notifications instead of one per chunk', async () => {
    const { registry } = openRegistry()
    const started = registry.start(
      job({ command: 'for i in $(seq 1 200); do echo line-$i; done' }),
    )
    if (!started.ok) throw new Error(started.reason)

    let notifications = 0
    registry.subscribe(() => {
      notifications += 1
    })

    await settle({ registry, shellId: started.snapshot.shellId })
    await Bun.sleep(150)

    expect(registry.version()).toBeGreaterThan(1)
    expect(notifications).toBeLessThan(50)
  })

  it('stops notifying after unsubscribe', async () => {
    const { registry } = openRegistry()
    let notifications = 0
    const unsubscribe = registry.subscribe(() => {
      notifications += 1
    })
    unsubscribe()

    registry.start(job({ command: 'echo done' }))
    await Bun.sleep(0)

    expect(notifications).toBe(0)
  })
})
