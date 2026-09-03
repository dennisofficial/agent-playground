import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'bun:test'

import {
  EKilledBy,
  EServiceStatus,
  EStopAction,
  toThreadId,
  type ClockPort,
  type ThreadId,
} from '@dltech/atlas-core'

import { logTail } from '../service-process'
import { BunServiceRegistry } from '../service-registry'

const THREAD = toThreadId('thread-under-test')
const ELSEWHERE = toThreadId('thread-next-door')

class SteppableClock implements ClockPort {
  private millis = Date.parse('2026-09-02T12:00:00.000Z')

  now(): string {
    return new Date(this.millis).toISOString()
  }

  advance(by: number): void {
    this.millis += by
  }
}

const opened: { registry: BunServiceRegistry; root: string }[] = []

function openRegistry(): { registry: BunServiceRegistry; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'atlas-services-'))
  const registry = new BunServiceRegistry(root, new SteppableClock(), join(root, 'logs'))
  opened.push({ registry, root })
  return { registry, root }
}

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.registry.closeAll()
    rmSync(entry.root, { recursive: true, force: true })
  }
})

async function settle({
  registry,
  serviceId,
}: {
  registry: BunServiceRegistry
  serviceId: string
}): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const snapshot = registry.list().find((entry) => entry.serviceId === serviceId)
    if (snapshot !== undefined && snapshot.exitCode !== undefined) return
    await Bun.sleep(25)
  }
  throw new Error(`service ${serviceId} never recorded an exit`)
}

async function announced({
  registry,
  threadId = THREAD,
}: {
  registry: BunServiceRegistry
  threadId?: ThreadId
}): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (registry.pendingNotices({ threadId }).length > 0) return
    await Bun.sleep(25)
  }
  throw new Error('no service ending was ever announced')
}

describe('starting a service', () => {
  it('mints a short id, records the pid, and points at a log file', async () => {
    const { registry } = openRegistry()

    const started = await registry.start({
      threadId: THREAD,
      command: 'sleep 30',
      description: 'web dev server',
    })

    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.snapshot.serviceId).toBe('svc_1')
    expect(started.snapshot.status).toBe(EServiceStatus.Running)
    expect(started.snapshot.pid).toBeGreaterThan(0)
    expect(started.snapshot.logPath).toMatch(/svc_1\.[0-9a-f]{8}\.log$/)
  })

  it('reports a command that exits during the settle window as an immediate exit, not a start', async () => {
    const { registry } = openRegistry()

    const started = await registry.start({
      threadId: THREAD,
      command: 'echo doom; exit 3',
      description: 'broken server',
    })

    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.snapshot.status).toBe(EServiceStatus.Exited)
    expect(started.snapshot.exitCode).toBe(3)
  })

  it('writes stdout and stderr to the one log file', async () => {
    const { registry } = openRegistry()

    const started = await registry.start({
      threadId: THREAD,
      command: 'echo out; echo err >&2; sleep 30',
      description: 'chatty server',
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return

    for (let attempt = 0; attempt < 80; attempt += 1) {
      const log = logTail({ path: started.snapshot.logPath, characters: 4_000 })
      if (log.includes('out') && log.includes('err')) return
      await Bun.sleep(25)
    }
    throw new Error('the service log never held both streams')
  })
})

describe('stopping a service', () => {
  it('SIGTERMs first and reports the escalation as prose actions', async () => {
    const { registry } = openRegistry()
    const started = await registry.start({
      threadId: THREAD,
      command: "trap '' TERM; sleep 30",
      description: 'stubborn server',
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return

    const first = registry.stop({ serviceId: 'svc_1', by: EKilledBy.Model })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.action).toBe(EStopAction.Term)
    expect(first.snapshot.status).toBe(EServiceStatus.Killed)
    expect(first.snapshot.killedBy).toBe(EKilledBy.Model)

    const second = registry.stop({ serviceId: 'svc_1', by: EKilledBy.Model })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.action).toBe(EStopAction.Kill)

    await settle({ registry, serviceId: 'svc_1' })

    const third = registry.stop({ serviceId: 'svc_1', by: EKilledBy.Model })
    expect(third.ok).toBe(true)
    if (!third.ok) return
    expect(third.action).toBe(EStopAction.Gone)
  })

  it('answers an unknown id with a sentence naming what is registered', async () => {
    const { registry } = openRegistry()
    await registry.start({ threadId: THREAD, command: 'sleep 30', description: 'web dev server' })

    const stopped = registry.stop({ serviceId: 'svc_99', by: EKilledBy.Model })

    expect(stopped.ok).toBe(false)
    if (stopped.ok) return
    expect(stopped.reason).toContain('svc_99')
    expect(stopped.reason).toContain('svc_1')
  })
})

describe('a service ending', () => {
  it('is announced to the thread that started it, with the log tail in hand', async () => {
    const { registry } = openRegistry()
    await registry.start({
      threadId: THREAD,
      command: 'echo last words; exit 1',
      description: 'doomed server',
    })

    await announced({ registry })

    const drafts = registry.drainNotifications({ threadId: THREAD })
    expect(drafts).toHaveLength(1)
    const draft = drafts[0]
    expect(draft?.type).toBe('service-ended')
    if (draft?.type !== 'service-ended') return
    expect(draft.serviceId).toBe('svc_1')
    expect(draft.status).toBe(EServiceStatus.Exited)
    expect(draft.exitCode).toBe(1)
    expect(draft.tail).toContain('last words')
    expect(draft.logPath).toMatch(/svc_1\.[0-9a-f]{8}\.log$/)
  })

  it('is announced only once', async () => {
    const { registry } = openRegistry()
    await registry.start({ threadId: THREAD, command: 'exit 0', description: 'brief server' })
    await announced({ registry })

    expect(registry.drainNotifications({ threadId: THREAD })).toHaveLength(1)
    expect(registry.drainNotifications({ threadId: THREAD })).toHaveLength(0)
    expect(registry.pendingNotices({ threadId: THREAD })).toHaveLength(0)
  })

  it('routes to the owning thread, not whichever thread drains first', async () => {
    const { registry } = openRegistry()
    await registry.start({ threadId: ELSEWHERE, command: 'exit 0', description: 'elsewhere' })
    await announced({ registry, threadId: ELSEWHERE })

    expect(registry.drainNotifications({ threadId: THREAD })).toHaveLength(0)
    expect(registry.threadsAwaitingNotice()).toEqual([ELSEWHERE])
  })
})

describe('listing services', () => {
  it('is session-wide: a thread that started nothing sees what another started', async () => {
    const { registry } = openRegistry()
    await registry.start({ threadId: ELSEWHERE, command: 'sleep 30', description: 'shared stack' })

    const listed = registry.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.serviceId).toBe('svc_1')
  })
})

describe('closing the session', () => {
  it('stops everything and still queues the endings', async () => {
    const { registry } = openRegistry()
    await registry.start({ threadId: THREAD, command: 'sleep 30', description: 'web dev server' })
    await registry.start({ threadId: THREAD, command: 'sleep 30', description: 'api server' })

    await registry.closeAll()

    expect(registry.list()).toHaveLength(0)
    const drafts = registry.drainNotifications({ threadId: THREAD })
    expect(drafts).toHaveLength(2)
    for (const draft of drafts) {
      expect(draft.type).toBe('service-ended')
      if (draft.type !== 'service-ended') continue
      expect(draft.killedBy).toBe(EKilledBy.SessionEnd)
    }
  })

  it('escalates to SIGKILL for a service that ignores SIGTERM', async () => {
    const { registry } = openRegistry()
    await registry.start({
      threadId: THREAD,
      command: "trap '' TERM; sleep 30",
      description: 'stubborn server',
    })

    const before = Date.now()
    await registry.closeAll()

    expect(Date.now() - before).toBeLessThan(10_000)
    expect(registry.list()).toHaveLength(0)
  })
})
