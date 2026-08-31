import { afterEach, describe, expect, it } from 'bun:test'

import { EAgentStatus, EKilledBy, type ThreadId } from '@dltech/atlas-core'

import { scriptedModel } from '../../../model/testing/scripted-model'
import { buildHarness, type AtlasHarness } from '../../../loop/build-harness'
import { createTempDatabase, type TempDatabase } from '../../../loop/__tests__/temp-database'
import { AgentSupervisor } from '../supervisor'
import {
  agentTypeNamed,
  calledTool,
  fakeRunners,
  finished,
  interrupted,
  said,
  type FakeRunners,
} from './fixtures'

const EXPLORE = agentTypeNamed({ name: 'explore' })
const BUILDER = agentTypeNamed({ name: 'builder' })

const opened: { harness: AtlasHarness; temp: TempDatabase }[] = []

type Opened = {
  harness: AtlasHarness
  runners: FakeRunners
  supervisor: AgentSupervisor
  parent: ThreadId
}

async function open(): Promise<Opened> {
  const temp = createTempDatabase()
  const harness = await buildHarness({
    databaseUrl: temp.databaseUrl,
    model: scriptedModel({ script: [] }),
  })
  opened.push({ harness, temp })

  const runners = fakeRunners()
  const supervisor = new AgentSupervisor({
    log: harness.log,
    threads: harness.threads,
    ids: harness.ids,
    clock: harness.clock,
    agentTypes: [EXPLORE, BUILDER],
    runners: runners.source,
  })
  const parent = (await harness.threads.create({})).id

  return { harness, runners, supervisor, parent }
}

const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.harness.close()
    entry.temp.discard()
  }
})

describe('spawning', () => {
  it("seeds the child's own log with the brief so it has something to answer", async () => {
    const { harness, supervisor, parent } = await open()

    const outcome = await supervisor.spawn({
      threadId: parent,
      agentType: 'explore',
      brief: 'find every call site of assemble',
      intent: 'find assemble callers',
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const events = await harness.log.read({ threadId: outcome.snapshot.agentId })
    expect(events.map((event) => event.type)).toEqual(['user-said'])
    expect(events[0]?.type === 'user-said' ? events[0].text : '').toBe(
      'find every call site of assemble',
    )
  })

  it('records the spawn on the parent, and records the child as supervised', async () => {
    const { harness, supervisor, parent } = await open()

    const outcome = await supervisor.spawn({
      threadId: parent,
      agentType: 'explore',
      brief: 'look around',
      intent: 'a look around',
    })
    if (!outcome.ok) throw new Error(outcome.reason)

    const events = await harness.log.readOwn({ threadId: parent })
    expect(events.map((event) => event.type)).toEqual(['agent-spawned'])
    expect(events[0]?.type === 'agent-spawned' ? events[0].agentId : '').toBe(
      outcome.snapshot.agentId,
    )

    const child = await harness.threads.find({ threadId: outcome.snapshot.agentId })
    expect(child?.agent).toEqual({ spawnedBy: parent, type: 'explore' })
  })

  it("holds no row of the child's on the parent's log, ever", async () => {
    const { harness, runners, supervisor, parent } = await open()
    const outcome = await supervisor.spawn({
      threadId: parent,
      agentType: 'explore',
      brief: 'look around',
      intent: 'a look around',
    })
    if (!outcome.ok) throw new Error(outcome.reason)

    await settle()
    runners.started[0]?.observe(said('I looked around'))
    runners.started[0]?.settle(finished())
    await supervisor.closeAll()

    const onParent = await harness.log.readOwn({ threadId: parent })
    expect(onParent.every((event) => event.threadId === parent)).toBe(true)
    expect(onParent.map((event) => event.type)).toEqual(['agent-spawned'])
  })

  it('refuses a type it does not know, naming the ones it does', async () => {
    const { supervisor, parent } = await open()

    const outcome = await supervisor.spawn({
      threadId: parent,
      agentType: 'archaeologist',
      brief: 'dig',
      intent: 'dig',
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.ok ? '' : outcome.reason).toMatch(/known types: explore, builder/)
  })
})

describe('an ending', () => {
  const spawnOne = async (opened: Opened): Promise<ThreadId> => {
    const outcome = await opened.supervisor.spawn({
      threadId: opened.parent,
      agentType: 'explore',
      brief: 'look around',
      intent: 'a look around',
    })
    if (!outcome.ok) throw new Error(outcome.reason)
    await settle()
    return outcome.snapshot.agentId
  }

  it('queues a notice for the parent carrying the last thing the child said', async () => {
    const opened = await open()
    const agentId = await spawnOne(opened)

    opened.runners.started[0]?.observe(said('nothing calls it'))
    opened.runners.started[0]?.observe(calledTool('grep'))
    opened.runners.started[0]?.settle(finished())
    await opened.supervisor.closeAll()

    const drafts = opened.supervisor.drainNotifications({ threadId: opened.parent })
    expect(drafts).toEqual([
      {
        type: 'agent-ended',
        agentId,
        agentType: 'explore',
        intent: 'a look around',
        status: EAgentStatus.Finished,
        prose: 'nothing calls it',
        turns: 1,
        toolCalls: 1,
      },
    ])
  })

  it('reaches the parent and nobody else', async () => {
    const opened = await open()
    await spawnOne(opened)
    const stranger = (await opened.harness.threads.create({})).id

    opened.runners.started[0]?.settle(finished())
    await opened.supervisor.closeAll()

    expect(opened.supervisor.threadsAwaitingNotice()).toEqual([opened.parent])
    expect(opened.supervisor.drainNotifications({ threadId: stranger })).toEqual([])
    expect(opened.supervisor.pendingNotices({ threadId: opened.parent })).toHaveLength(1)
  })

  it('wakes whoever is listening', async () => {
    const opened = await open()
    await spawnOne(opened)
    let woken = 0
    opened.supervisor.onNotice(() => {
      woken += 1
    })

    opened.runners.started[0]?.settle(finished())
    await opened.supervisor.closeAll()

    expect(woken).toBeGreaterThan(0)
  })
})

describe('stopping', () => {
  it('aborts the step the child is taking, and records it as stopped', async () => {
    const opened = await open()
    const outcome = await opened.supervisor.spawn({
      threadId: opened.parent,
      agentType: 'builder',
      brief: 'write the thing',
      intent: 'write the thing',
    })
    if (!outcome.ok) throw new Error(outcome.reason)
    await settle()

    opened.supervisor.stop({
      agentId: outcome.snapshot.agentId,
      threadId: opened.parent,
      by: EKilledBy.Model,
    })
    expect(opened.runners.started[0]?.signal.aborted).toBe(true)

    opened.runners.started[0]?.settle(interrupted())
    await opened.supervisor.closeAll()

    const [draft] = opened.supervisor.drainNotifications({ threadId: opened.parent })
    expect(draft?.type === 'agent-ended' ? draft.status : undefined).toBe(EAgentStatus.Stopped)
  })

  it('refuses an agent another conversation supervises', async () => {
    const opened = await open()
    const outcome = await opened.supervisor.spawn({
      threadId: opened.parent,
      agentType: 'builder',
      brief: 'write the thing',
      intent: 'write the thing',
    })
    if (!outcome.ok) throw new Error(outcome.reason)
    const stranger = (await opened.harness.threads.create({})).id

    const stopped = opened.supervisor.stop({
      agentId: outcome.snapshot.agentId,
      threadId: stranger,
      by: EKilledBy.User,
    })

    expect(stopped.ok).toBe(false)
    expect(opened.runners.started[0]?.signal.aborted).toBe(false)
  })
})

describe('many children at once', () => {
  it('starts every one of them stepping, capping nothing', async () => {
    const opened = await open()

    for (const intent of ['one', 'two', 'three', 'four', 'five', 'six']) {
      await opened.supervisor.spawn({
        threadId: opened.parent,
        agentType: 'explore',
        brief: `do the ${intent} thing`,
        intent,
      })
    }
    await settle()

    expect(opened.runners.started).toHaveLength(6)
    expect(opened.supervisor.list({ threadId: opened.parent })).toHaveLength(6)
  })
})

describe('steering a child', () => {
  it('hands a message to the step in flight rather than appending behind it', async () => {
    const opened = await open()
    const outcome = await opened.supervisor.spawn({
      threadId: opened.parent,
      agentType: 'builder',
      brief: 'write the thing',
      intent: 'write the thing',
    })
    if (!outcome.ok) throw new Error(outcome.reason)
    await settle()

    await opened.supervisor.say({
      agentId: outcome.snapshot.agentId,
      threadId: opened.parent,
      text: 'use the other file',
    })

    const events = await opened.harness.log.read({ threadId: outcome.snapshot.agentId })
    expect(events.map((event) => event.type)).toEqual(['user-said'])
    expect(opened.runners.started[0]?.request.steering()).toEqual(['use the other file'])
  })

  it('starts a fresh turn on a child that has already settled', async () => {
    const opened = await open()
    const outcome = await opened.supervisor.spawn({
      threadId: opened.parent,
      agentType: 'builder',
      brief: 'write the thing',
      intent: 'write the thing',
    })
    if (!outcome.ok) throw new Error(outcome.reason)
    await settle()
    opened.runners.started[0]?.settle(finished())
    await settle()

    await opened.supervisor.say({
      agentId: outcome.snapshot.agentId,
      threadId: opened.parent,
      text: 'one more thing',
    })
    await settle()

    expect(opened.runners.started).toHaveLength(2)
    const events = await opened.harness.log.read({ threadId: outcome.snapshot.agentId })
    expect(events.map((event) => event.type)).toEqual(['user-said', 'user-said'])
  })
})
