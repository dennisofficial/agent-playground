import { afterEach, describe, expect, it } from 'bun:test'

import { EKilledBy, EShellStatus } from '@dltech/atlas-core'

import {
  closeRegistries,
  dockerShellAdapter,
  endedDraft,
  job,
  openRegistry,
  THREAD,
} from './shell-registry-fixture'

afterEach(closeRegistries)

const describeDocker = dockerShellAdapter.available ? describe : describe.skip

describeDocker('a background shell inside a container', () => {
  it('drains its output before the container stops, so the teardown ending is not empty', async () => {
    const { registry, root } = openRegistry({ adapter: dockerShellAdapter })
    const started = registry.start(job({ command: 'echo kept-through-teardown; sleep 60' }))
    if (!started.ok) throw new Error(started.reason)

    let visible = ''
    for (let attempt = 0; attempt < 400 && !visible.includes('kept-through-teardown'); attempt++) {
      visible =
        registry.peek({
          shellId: started.snapshot.shellId,
          characters: 1000,
          threadId: THREAD,
        }) ?? ''
      await Bun.sleep(25)
    }
    expect(visible).toContain('kept-through-teardown')

    await registry.closeAll()
    await dockerShellAdapter.sweep({ root })

    const drained = registry.drainNotifications({ threadId: THREAD })
    expect(drained).toHaveLength(1)
    expect(endedDraft(drained[0])).toMatchObject({
      status: EShellStatus.Killed,
      killedBy: EKilledBy.SessionEnd,
    })
    expect(endedDraft(drained[0]).output).toContain('kept-through-teardown')
  }, 30_000)
})
