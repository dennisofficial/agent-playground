import { afterEach, describe, expect, it } from 'bun:test'

import type { ProcessPort, SpawnCommand } from '@dltech/atlas-core'

import { closeRegistries, job, openRegistry, type ShellAdapter } from './shell-registry-fixture'

afterEach(closeRegistries)

describe('a background shell carrying its thread to the process port', () => {
  it('names the owning thread on the spawn, so a routed port can place it', async () => {
    const spawned: SpawnCommand[] = []
    const recording: ShellAdapter = {
      name: 'recording',
      available: true,
      processes: (): ProcessPort => ({
        spawn: (args: SpawnCommand) => {
          spawned.push(args)
          return {
            stdout: new ReadableStream({ start: (controller) => controller.close() }),
            stderr: new ReadableStream({ start: (controller) => controller.close() }),
            exited: Promise.resolve(0),
            terminate: () => undefined,
          }
        },
        which: () => null,
      }),
      sweep: async () => {},
    }
    const { registry } = openRegistry({ adapter: recording })

    const started = registry.start(job({ command: 'true' }))

    expect(started.ok).toBe(true)
    expect(spawned[0]?.threadId).toBe(job({ command: 'true' }).threadId)
  })
})
