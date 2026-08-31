import { afterEach, describe, expect, it } from 'bun:test'

import { EAgentStatus, type ThreadId } from '@dltech/atlas-core'

import { createTempDatabase, type TempDatabase } from '../../../loop/__tests__/temp-database'
import { buildHarness, type AtlasHarness } from '../../../loop/build-harness'
import { scriptedModel } from '../../../model/testing/scripted-model'
import { AgentSupervisor } from '../supervisor'
import { agentTypeNamed, calledTool, fakeRunners, finished, type FakeRunners } from './fixtures'

const EXPLORE = agentTypeNamed({ name: 'explore' })

const opened: { harness: AtlasHarness; temp: TempDatabase }[] = []

type Opened = {
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
    agentTypes: [EXPLORE],
    runners: runners.source,
  })

  return { runners, supervisor, parent: (await harness.threads.create({})).id }
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

describe('the roster a sidebar reads', () => {
  it('hands back the same listing until something about a child changes', async () => {
    const { supervisor, parent } = await open()
    await supervisor.spawn({
      threadId: parent,
      agentType: 'explore',
      brief: 'look',
      intent: 'looking',
    })

    const first = supervisor.list({ threadId: parent })
    expect(supervisor.list({ threadId: parent })).toBe(first)
    expect(supervisor.listEverywhere()).toBe(supervisor.listEverywhere())
  })

  it('announces a spawn to a listener without waiting for an ending', async () => {
    const { supervisor, parent } = await open()
    let changes = 0
    supervisor.onChange(() => {
      changes += 1
    })

    await supervisor.spawn({
      threadId: parent,
      agentType: 'explore',
      brief: 'look',
      intent: 'looking',
    })

    expect(changes).toBeGreaterThan(0)
    expect(supervisor.list({ threadId: parent })).toHaveLength(1)
  })

  it('replaces the listing when a child records work of its own', async () => {
    const { runners, supervisor, parent } = await open()
    await supervisor.spawn({
      threadId: parent,
      agentType: 'explore',
      brief: 'look',
      intent: 'looking',
    })

    const before = supervisor.list({ threadId: parent })
    runners.started[0]?.observe(calledTool('grep'))

    const after = supervisor.list({ threadId: parent })
    expect(after).not.toBe(before)
    expect(after[0]?.toolCalls).toBe(1)
    expect(before[0]?.toolCalls).toBe(0)
  })

  it('marks a child finished on the listing once its step settles', async () => {
    const { runners, supervisor, parent } = await open()
    await supervisor.spawn({
      threadId: parent,
      agentType: 'explore',
      brief: 'look',
      intent: 'looking',
    })

    runners.started[0]?.settle(finished())
    await settle()

    expect(supervisor.list({ threadId: parent })[0]?.status).toBe(EAgentStatus.Finished)
  })

  it('keeps a child off another thread listing', async () => {
    const { supervisor, parent } = await open()
    await supervisor.spawn({
      threadId: parent,
      agentType: 'explore',
      brief: 'look',
      intent: 'looking',
    })

    expect(supervisor.list({ threadId: 'someone-else' as ThreadId })).toHaveLength(0)
    expect(supervisor.listEverywhere()).toHaveLength(1)
  })
})
