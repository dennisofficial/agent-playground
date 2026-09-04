import { afterEach, describe, expect, it } from 'bun:test'

import { EKilledBy } from '@dltech/atlas-core'

import {
  announced,
  closeRegistries,
  ELSEWHERE,
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
    describe('keeping shells scoped to the thread that started them', () => {
      it('lists only the shells the asking thread started', () => {
        const { registry } = openRegistry({ adapter })
        const mine = registry.start(job({ command: 'sleep 30' }))
        const theirs = registry.start(job({ command: 'sleep 30', threadId: ELSEWHERE }))
        if (!mine.ok || !theirs.ok) throw new Error('both shells should have started')

        expect(registry.list({ threadId: THREAD }).map((entry) => entry.shellId)).toEqual([
          mine.snapshot.shellId,
        ])
        expect(registry.list({ threadId: ELSEWHERE }).map((entry) => entry.shellId)).toEqual([
          theirs.snapshot.shellId,
        ])
        expect(registry.listEverywhere()).toHaveLength(2)
      })

      it('refuses to read, peek at, or kill a shell another thread started', async () => {
        const { registry } = openRegistry({ adapter })
        const theirs = registry.start(job({ command: 'echo private', threadId: ELSEWHERE }))
        if (!theirs.ok) throw new Error(theirs.reason)
        await settle({ registry, shellId: theirs.snapshot.shellId, threadId: ELSEWHERE })

        expect(registry.read({ shellId: theirs.snapshot.shellId, threadId: THREAD }).ok).toBe(false)
        expect(
          registry.peek({ shellId: theirs.snapshot.shellId, characters: 100, threadId: THREAD }),
        ).toBeUndefined()
        expect(
          registry.kill({ shellId: theirs.snapshot.shellId, by: EKilledBy.Model, threadId: THREAD })
            .ok,
        ).toBe(false)
        expect(registry.read({ shellId: theirs.snapshot.shellId, threadId: ELSEWHERE }).ok).toBe(
          true,
        )
      })

      it('announces an ending only to the thread that started the shell', async () => {
        const { registry } = openRegistry({ adapter })
        const theirs = registry.start(job({ command: 'echo elsewhere', threadId: ELSEWHERE }))
        if (!theirs.ok) throw new Error(theirs.reason)
        await settle({ registry, shellId: theirs.snapshot.shellId, threadId: ELSEWHERE })
        await announced({ registry, threadId: ELSEWHERE })

        expect(registry.pendingNotices({ threadId: THREAD })).toEqual([])
        expect(registry.drainNotifications({ threadId: THREAD })).toEqual([])
        expect(registry.threadsAwaitingNotice()).toEqual([ELSEWHERE])
        expect(registry.drainNotifications({ threadId: ELSEWHERE })).toHaveLength(1)
      })
    })
  })
}
