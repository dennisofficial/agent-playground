import { afterEach, describe, expect, it } from 'bun:test'
import { join } from 'node:path'

import {
  closeRegistries,
  job,
  openRegistry,
  settle,
  shellAdapters,
  THREAD,
} from './shell-registry-fixture'

afterEach(closeRegistries)

for (const adapter of shellAdapters) {
  const describeAdapter = adapter.available ? describe : describe.skip

  describeAdapter(`${adapter.name} process adapter`, () => {
    describe('closing the session down', () => {
      it('kills what the session left running, so no shell outlives its spawner', async () => {
        const { registry, root } = openRegistry({ adapter })
        const witness = join(root, 'zombie.txt')
        const started = registry.start(job({ command: `sleep 2; echo alive > ${witness}` }))
        if (!started.ok) throw new Error(started.reason)
        await Bun.sleep(150)

        await registry.closeAll()
        await Bun.sleep(2200)

        expect(await Bun.file(witness).exists()).toBe(false)
      }, 15_000)

      it('forgets the shells, so a stale id is not silently readable after teardown', async () => {
        const { registry } = openRegistry({ adapter })
        registry.start(job({ command: 'sleep 30' }))

        await registry.closeAll()

        expect(registry.list({ threadId: THREAD })).toEqual([])
        expect(registry.read({ shellId: 'bash_1', threadId: THREAD }).ok).toBe(false)
      })

      it('keeps a pending notification through teardown, so the ending is not lost with the shell', async () => {
        const { registry } = openRegistry({ adapter })
        const started = registry.start(job({ command: 'echo hi' }))
        if (!started.ok) throw new Error(started.reason)
        await settle({ registry, shellId: started.snapshot.shellId })

        await registry.closeAll()

        expect(registry.drainNotifications({ threadId: THREAD })).toHaveLength(1)
      })
    })
  })
}
