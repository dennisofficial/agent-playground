import { afterEach, describe, expect, it } from 'bun:test'

import {
  announced,
  closeRegistries,
  endedDraft,
  job,
  openRegistry,
  settle,
  THREAD,
} from './shell-registry-fixture'

afterEach(closeRegistries)

describe('releasing the output of a dead shell', () => {
  it('releases the retained output once the ending has been drained, but keeps the shell readable', async () => {
    const { registry } = openRegistry()
    const started = registry.start(job({ command: 'echo delivered' }))
    if (!started.ok) throw new Error(started.reason)
    await settle({ registry, shellId: started.snapshot.shellId })
    await announced({ registry })

    registry.drainNotifications({ threadId: THREAD })

    expect(
      registry.peek({ shellId: started.snapshot.shellId, characters: 1000, threadId: THREAD }),
    ).toBe('')

    const read = registry.read({ shellId: started.snapshot.shellId, threadId: THREAD })
    expect(read.ok && read.delta.text).toBe('')
    expect(read.ok && read.delta.remainingCharacters).toBe(0)
  })

  it('keeps the retained output while the ending has not been drained yet', async () => {
    const { registry } = openRegistry()
    const started = registry.start(job({ command: 'echo still-waiting' }))
    if (!started.ok) throw new Error(started.reason)
    await settle({ registry, shellId: started.snapshot.shellId })
    await announced({ registry })

    expect(
      registry.peek({ shellId: started.snapshot.shellId, characters: 1000, threadId: THREAD }),
    ).toBe('still-waiting\n')
  })

  it('keeps what a drained ending could not carry until the rest has been read', async () => {
    const { registry } = openRegistry()
    const started = registry.start(job({ command: 'yes y | head -c 40000' }))
    if (!started.ok) throw new Error(started.reason)
    await settle({ registry, shellId: started.snapshot.shellId })
    await announced({ registry })

    const delivered = endedDraft(registry.drainNotifications({ threadId: THREAD })[0])

    expect(delivered.remainingCharacters).toBeGreaterThan(0)
    expect(
      registry.peek({ shellId: started.snapshot.shellId, characters: 1000, threadId: THREAD }),
    ).toBe('y\n'.repeat(500))

    const read = registry.read({ shellId: started.snapshot.shellId, threadId: THREAD })
    expect(read.ok && read.delta.remainingCharacters).toBe(0)

    expect(
      registry.peek({ shellId: started.snapshot.shellId, characters: 1000, threadId: THREAD }),
    ).toBe('')
  })
})
