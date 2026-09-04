import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'bun:test'

import { toThreadId, type ClockPort } from '@dltech/atlas-core'

import { BunServiceRegistry } from '../service-registry'

const THREAD = toThreadId('thread-under-test')

class FixedClock implements ClockPort {
  now(): string {
    return '2026-09-04T12:00:00.000Z'
  }
}

const opened: { registry: BunServiceRegistry; root: string }[] = []

function openRegistry(): { registry: BunServiceRegistry; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'atlas-services-'))
  const registry = new BunServiceRegistry(root, new FixedClock(), join(root, 'logs'))
  opened.push({ registry, root })
  return { registry, root }
}

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.registry.closeAll()
    rmSync(entry.root, { recursive: true, force: true })
  }
})

describe('service registry versioning', () => {
  it('publishes a start to subscribers and raises the version', async () => {
    const { registry } = openRegistry()
    const seen: number[] = []
    registry.subscribe(() => seen.push(registry.version()))

    const started = await registry.start({
      threadId: THREAD,
      command: 'echo done',
      description: 'Run a background service',
    })
    if (!started.ok) throw new Error(started.reason)
    await Bun.sleep(0)

    expect(registry.version()).toBeGreaterThanOrEqual(1)
    expect(seen.length).toBeGreaterThanOrEqual(1)
  })
})
