import { afterEach, describe, expect, it } from 'bun:test'

import type { ClockPort, ThreadId } from '@dltech/atlas-core'

import { createTempDatabase, type TempDatabase } from '../../../loop/__tests__/temp-database'
import { buildHarness, type AtlasHarness } from '../../../loop/build-harness'
import { scriptedModel } from '../../../model/testing/scripted-model'
import { AgentSupervisor } from '../supervisor'
import { agentTypeNamed, fakeRunners, finished, type FakeRunners } from './fixtures'

const EXPLORE = agentTypeNamed({ name: 'explore' })

const opened: { harness: AtlasHarness; temp: TempDatabase }[] = []

const tickingClock = (): ClockPort => {
  let ticks = 0
  return { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, ticks++)).toISOString() }
}

type Opened = {
  runners: FakeRunners
  supervisor: AgentSupervisor
  clock: ClockPort
  parent: ThreadId
  other: ThreadId
}

async function open(): Promise<Opened> {
  const temp = createTempDatabase()
  const harness = await buildHarness({
    databaseUrl: temp.databaseUrl,
    model: scriptedModel({ script: [] }),
  })
  opened.push({ harness, temp })

  const runners = fakeRunners()
  const clock = tickingClock()

  return {
    runners,
    clock,
    supervisor: new AgentSupervisor({
      log: harness.log,
      threads: harness.threads,
      ids: harness.ids,
      clock,
      agentTypes: [EXPLORE],
      runners: runners.source,
    }),
    parent: (await harness.threads.create({})).id,
    other: (await harness.threads.create({})).id,
  }
}

const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

async function spawnUnder({
  supervisor,
  threadId,
}: {
  supervisor: AgentSupervisor
  threadId: ThreadId
}): Promise<ThreadId> {
  const outcome = await supervisor.spawn({
    threadId,
    agentType: 'explore',
    brief: 'look',
    intent: 'looking',
  })
  if (!outcome.ok) throw new Error(outcome.reason)
  return outcome.snapshot.agentId
}

const deliveryOf = ({
  supervisor,
  threadId,
  agentId,
}: {
  supervisor: AgentSupervisor
  threadId: ThreadId
  agentId: ThreadId
}): string | undefined =>
  supervisor.list({ threadId }).find((one) => one.agentId === agentId)?.deliveredAt

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.harness.close()
    entry.temp.discard()
  }
})

describe('when a finished child counts as delivered', () => {
  it('leaves a child whose notice nobody has read carrying no delivery', async () => {
    const { runners, supervisor, parent } = await open()
    const agentId = await spawnUnder({ supervisor, threadId: parent })

    runners.started[0]?.settle(finished())
    await settle()

    expect(supervisor.pendingNotices({ threadId: parent })).toHaveLength(1)
    expect(deliveryOf({ supervisor, threadId: parent, agentId })).toBeUndefined()
  })

  it('stamps the child when its parent drains the notice', async () => {
    const { runners, supervisor, clock, parent } = await open()
    const agentId = await spawnUnder({ supervisor, threadId: parent })

    runners.started[0]?.settle(finished())
    await settle()

    const drafts = supervisor.drainNotifications({ threadId: parent })
    const next = clock.now()

    expect(drafts).toHaveLength(1)
    const delivered = deliveryOf({ supervisor, threadId: parent, agentId })
    expect(delivered).toBeDefined()
    expect(delivered !== undefined && delivered < next).toBe(true)
  })

  it('leaves a child alone when a different thread drains', async () => {
    const { runners, supervisor, parent, other } = await open()
    const agentId = await spawnUnder({ supervisor, threadId: parent })
    await spawnUnder({ supervisor, threadId: other })

    runners.started[0]?.settle(finished())
    runners.started[1]?.settle(finished())
    await settle()

    supervisor.drainNotifications({ threadId: other })

    expect(deliveryOf({ supervisor, threadId: parent, agentId })).toBeUndefined()
  })

  it('leaves a forgotten notice undelivered, because forgetting is a discard', async () => {
    const { runners, supervisor, parent } = await open()
    const agentId = await spawnUnder({ supervisor, threadId: parent })

    runners.started[0]?.settle(finished())
    await settle()

    supervisor.forgetNotices({ threadId: parent })

    expect(supervisor.pendingNotices({ threadId: parent })).toHaveLength(0)
    expect(deliveryOf({ supervisor, threadId: parent, agentId })).toBeUndefined()
  })

  it('keeps the first delivery when the thread drains again', async () => {
    const { runners, supervisor, parent } = await open()
    const agentId = await spawnUnder({ supervisor, threadId: parent })

    runners.started[0]?.settle(finished())
    await settle()

    supervisor.drainNotifications({ threadId: parent })
    const first = deliveryOf({ supervisor, threadId: parent, agentId })

    supervisor.drainNotifications({ threadId: parent })

    expect(deliveryOf({ supervisor, threadId: parent, agentId })).toBe(first)
  })

  it('announces the stamp so a sidebar re-reads the roster', async () => {
    const { runners, supervisor, parent } = await open()
    await spawnUnder({ supervisor, threadId: parent })

    runners.started[0]?.settle(finished())
    await settle()

    let changes = 0
    supervisor.onChange(() => {
      changes += 1
    })
    const before = supervisor.list({ threadId: parent })

    supervisor.drainNotifications({ threadId: parent })

    expect(changes).toBe(1)
    expect(supervisor.list({ threadId: parent })).not.toBe(before)
  })

  it('drops the delivery when the child is put back to work', async () => {
    const { runners, supervisor, parent } = await open()
    const agentId = await spawnUnder({ supervisor, threadId: parent })

    runners.started[0]?.settle(finished())
    await settle()
    supervisor.drainNotifications({ threadId: parent })

    await supervisor.resume({ agentId, threadId: parent })

    expect(deliveryOf({ supervisor, threadId: parent, agentId })).toBeUndefined()
  })
})
