import { afterEach, describe, expect, it } from 'bun:test'
import { join } from 'node:path'

import { EKilledBy } from '@dltech/atlas-core'

import { EShellStatus } from '../background-shell'
import { closeRegistries, job, openRegistry, settle, THREAD } from './shell-registry-fixture'

afterEach(closeRegistries)

describe('killing a background shell', () => {
  it('stops it and reports it killed rather than exited', async () => {
    const { registry } = openRegistry()
    const started = registry.start(job({ command: 'sleep 60' }))
    if (!started.ok) throw new Error(started.reason)

    const killed = registry.kill({
      shellId: started.snapshot.shellId,
      by: EKilledBy.User,
      threadId: THREAD,
    })
    expect(killed.ok).toBe(true)

    await settle({ registry, shellId: started.snapshot.shellId })
    const read = registry.read({ shellId: started.snapshot.shellId, threadId: THREAD })
    expect(read.ok && read.snapshot.status).toBe(EShellStatus.Killed)
  })

  it('reaches a process the shell forked, not only the shell', async () => {
    const { registry, root } = openRegistry()
    const witness = join(root, 'survivor.txt')
    const started = registry.start(job({ command: `(sleep 2; echo alive > ${witness}) & wait` }))
    if (!started.ok) throw new Error(started.reason)

    await Bun.sleep(150)
    registry.kill({ shellId: started.snapshot.shellId, by: EKilledBy.User, threadId: THREAD })
    await settle({ registry, shellId: started.snapshot.shellId })
    await Bun.sleep(2200)

    expect(await Bun.file(witness).exists()).toBe(false)
  })

  it('refuses a shell it does not know', () => {
    const { registry } = openRegistry()

    expect(registry.kill({ shellId: 'bash_7', by: EKilledBy.Model, threadId: THREAD }).ok).toBe(
      false,
    )
  })

  it('is harmless on a shell that already finished', async () => {
    const { registry } = openRegistry()
    const started = registry.start(job({ command: 'echo done' }))
    if (!started.ok) throw new Error(started.reason)
    await settle({ registry, shellId: started.snapshot.shellId })

    const killed = registry.kill({
      shellId: started.snapshot.shellId,
      by: EKilledBy.User,
      threadId: THREAD,
    })

    expect(killed.ok && killed.snapshot.status).toBe(EShellStatus.Exited)
  })
})
