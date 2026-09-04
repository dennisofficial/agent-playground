import { afterEach, describe, expect, it } from 'bun:test'

import { EKilledBy, EShellStatus, type PortExposure } from '@dltech/atlas-core'

import {
  announced,
  closeRegistries,
  job,
  localShellAdapter,
  openRegistry,
  THREAD,
} from './shell-registry-fixture'

afterEach(closeRegistries)

const EXPOSURE: PortExposure = {
  containerPort: 3000,
  hostPort: 41_237,
  url: 'http://localhost:41237',
}

describe('a background shell with an exposed port', () => {
  it('carries the mapping on its snapshot from the moment it starts', () => {
    const { registry } = openRegistry({ adapter: localShellAdapter })

    const started = registry.start({ ...job({ command: 'sleep 60' }), exposure: EXPOSURE })
    if (!started.ok) throw new Error(started.reason)

    expect(started.snapshot.exposure).toEqual(EXPOSURE)
    expect(registry.list({ threadId: THREAD })[0]?.exposure).toEqual(EXPOSURE)
  })

  it('carries no mapping on a shell that never asked for one', () => {
    const { registry } = openRegistry({ adapter: localShellAdapter })

    const started = registry.start(job({ command: 'sleep 60' }))
    if (!started.ok) throw new Error(started.reason)

    expect(started.snapshot.exposure).toBeUndefined()
  })

  it('keeps the mapping on the snapshot its ending notice carries', async () => {
    const { registry } = openRegistry({ adapter: localShellAdapter })

    const started = registry.start({ ...job({ command: 'sleep 60' }), exposure: EXPOSURE })
    if (!started.ok) throw new Error(started.reason)

    registry.kill({ shellId: started.snapshot.shellId, by: EKilledBy.User, threadId: THREAD })
    await announced({ registry })

    const pending = registry.pendingNotices({ threadId: THREAD })
    expect(pending[0]?.snapshot.status).toBe(EShellStatus.Killed)
    expect(pending[0]?.snapshot.exposure).toEqual(EXPOSURE)
  })
})
