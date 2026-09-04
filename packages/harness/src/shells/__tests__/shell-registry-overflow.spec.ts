import { afterEach, describe, expect, it } from 'bun:test'

import { EShellStatus } from '@dltech/atlas-core'

import { DELIVERED_CHARACTERS } from '../notice-queue'
import { OVERFLOW_CHARACTERS, RETAINED_CHARACTERS } from '../shell-registry'
import {
  announced,
  closeRegistries,
  endedDraft,
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
    describe('a shell that outprints the overflow cap', () => {
      it('is killed and the ending says it overflowed', async () => {
        const { registry } = openRegistry({ adapter })
        const started = registry.start(job({ command: 'yes y' }))
        if (!started.ok) throw new Error(started.reason)

        await settle({ registry, shellId: started.snapshot.shellId })
        await announced({ registry })

        const snapshot = registry
          .list({ threadId: THREAD })
          .find((entry) => entry.shellId === started.snapshot.shellId)
        expect(snapshot?.status).toBe(EShellStatus.Overflowed)

        const ended = endedDraft(registry.drainNotifications({ threadId: THREAD })[0])
        expect(ended.status).toBe(EShellStatus.Overflowed)
        expect(ended.output).toHaveLength(DELIVERED_CHARACTERS)
        expect(ended.droppedCharacters).toBeGreaterThan(
          OVERFLOW_CHARACTERS - RETAINED_CHARACTERS,
        )
      }, 60_000)
    })

    describe('the drop accounting a read reports', () => {
      it('counts the characters that fell out of the window, byte-identically', async () => {
        const { registry } = openRegistry({ adapter })
        const started = registry.start(
          job({ command: `yes y | head -c ${RETAINED_CHARACTERS + 1000}` }),
        )
        if (!started.ok) throw new Error(started.reason)
        await settle({ registry, shellId: started.snapshot.shellId })
        await announced({ registry })

        const ended = endedDraft(registry.drainNotifications({ threadId: THREAD })[0])

        expect(ended.status).toBe(EShellStatus.Exited)
        expect(ended.droppedCharacters).toBe(1000)
        expect(ended.output).toBe('y\n'.repeat(DELIVERED_CHARACTERS / 2))
        expect(ended.remainingCharacters).toBe(RETAINED_CHARACTERS - DELIVERED_CHARACTERS)
      }, 30_000)
    })
  })
}
