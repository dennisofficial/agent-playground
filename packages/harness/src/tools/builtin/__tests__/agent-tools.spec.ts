import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'bun:test'
import { z } from 'zod'

import {
  EKilledBy,
  toThreadId,
  type ThreadId,
  type ToolDefinition,
  type ToolOutcome,
} from '@dltech/atlas-core'

import {
  agentTypeNamed,
  fakeRunners,
  finished,
  interrupted,
  said,
  type FakeRunners,
} from '../../../agents/registry/__tests__/fixtures'
import { AgentSupervisor } from '../../../agents/registry/supervisor'
import type { AgentType } from '../../../agents/types/agent-type'
import { buildHarness, type AtlasHarness } from '../../../loop/build-harness'
import { createTempDatabase, type TempDatabase } from '../../../loop/__tests__/temp-database'
import { scriptedModel } from '../../../model/testing/scripted-model'
import { AgentListTool } from '../agent-list'
import { AgentResumeTool } from '../agent-resume'
import { AgentSayTool } from '../agent-say'
import { AgentSpawnTool } from '../agent-spawn'
import { AgentStopTool } from '../agent-stop'

const EXPLORE = agentTypeNamed({ name: 'explore' })
const BUILDER = agentTypeNamed({ name: 'builder' })
const TYPES: readonly AgentType[] = [EXPLORE, BUILDER]

const opened: { harness: AtlasHarness; temp: TempDatabase }[] = []

type Opened = {
  harness: AtlasHarness
  runners: FakeRunners
  supervisor: AgentSupervisor
  parent: ThreadId
  spawn: AgentSpawnTool
  say: AgentSayTool
  resume: AgentResumeTool
  list: AgentListTool
  stop: AgentStopTool
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
    agentTypes: TYPES,
    runners: runners.source,
  })
  const source = (): AgentSupervisor => supervisor

  return {
    harness,
    runners,
    supervisor,
    parent: (await harness.threads.create({})).id,
    spawn: new AgentSpawnTool(source, TYPES),
    say: new AgentSayTool(source),
    resume: new AgentResumeTool(source),
    list: new AgentListTool(source),
    stop: new AgentStopTool(source),
  }
}

const invoke = ({
  tool,
  input,
  threadId,
}: {
  tool: ToolDefinition
  input: unknown
  threadId: ThreadId
}): Promise<ToolOutcome> =>
  tool.invoke({
    input,
    signal: AbortSignal.timeout(10_000),
    idempotencyKey: 'key-1',
    sessionDirectory: tmpdir(),
    threadId,
  })

const spawnedIds = z.object({ agents: z.array(z.object({ agentId: z.string() })) })

function spawnedId(outcome: ToolOutcome): ThreadId {
  if (!outcome.ok) throw new Error(`the spawn was refused: ${outcome.reason}`)
  const first = spawnedIds.parse(outcome.output).agents[0]
  if (first === undefined) throw new Error('the spawn started nothing')
  return toThreadId(first.agentId)
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

describe('agent_spawn', () => {
  it('returns an agentId whose thread exists and whose runner has started', async () => {
    const open_ = await open()

    const outcome = await invoke({
      tool: open_.spawn,
      threadId: open_.parent,
      input: { agentType: 'explore', intent: 'audit the loop', brief: 'read run-turn.ts' },
    })

    const agentId = spawnedId(outcome)
    expect(await open_.harness.threads.find({ threadId: agentId })).toBeDefined()
    expect(open_.runners.started.map((one) => one.threadId)).toEqual([agentId])
  })

  it('names the intent and says the answer arrives on its own', async () => {
    const open_ = await open()

    const outcome = await invoke({
      tool: open_.spawn,
      threadId: open_.parent,
      input: { agentType: 'explore', intent: 'audit the loop', brief: 'read run-turn.ts' },
    })

    expect(outcome.ok && outcome.modelText).toContain('audit the loop')
    expect(outcome.ok && outcome.modelText).toContain('the moment it stops')
  })

  it('starts a whole wave from one agents array', async () => {
    const open_ = await open()

    const outcome = await invoke({
      tool: open_.spawn,
      threadId: open_.parent,
      input: {
        agents: [
          { agentType: 'explore', intent: 'find the callers', brief: 'grep for spawn' },
          { agentType: 'builder', intent: 'write the test', brief: 'add a spec' },
        ],
      },
    })

    expect(outcome.ok).toBe(true)
    expect(open_.runners.started).toHaveLength(2)
    expect(open_.supervisor.list({ threadId: open_.parent })).toHaveLength(2)
  })

  it('refuses a type nobody registered, naming the ones that exist', async () => {
    const open_ = await open()

    const outcome = await invoke({
      tool: open_.spawn,
      threadId: open_.parent,
      input: { agentType: 'archaeologist', intent: 'dig', brief: 'dig here' },
    })

    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.reason).toContain('explore, builder')
    expect(open_.runners.started).toHaveLength(0)
  })

  it('refuses a call that carries both a single agent and a wave', async () => {
    const open_ = await open()

    const outcome = await invoke({
      tool: open_.spawn,
      threadId: open_.parent,
      input: {
        agentType: 'explore',
        intent: 'dig',
        brief: 'dig here',
        agents: [{ agentType: 'builder', intent: 'build', brief: 'build it' }],
      },
    })

    expect(outcome.ok).toBe(false)
    expect(open_.runners.started).toHaveLength(0)
  })

  it('declares itself concurrency safe, so a turn of five spawns fans out', async () => {
    const open_ = await open()

    expect(open_.spawn.isConcurrencySafe?.()).toBe(true)
    expect(open_.list.isConcurrencySafe?.()).toBe(true)
  })
})

describe('agent_list', () => {
  it('shows this thread’s children and no other thread’s', async () => {
    const open_ = await open()
    const stranger = (await open_.harness.threads.create({})).id

    await invoke({
      tool: open_.spawn,
      threadId: open_.parent,
      input: { agentType: 'explore', intent: 'mine', brief: 'do mine' },
    })
    await invoke({
      tool: open_.spawn,
      threadId: stranger,
      input: { agentType: 'builder', intent: 'theirs', brief: 'do theirs' },
    })

    const outcome = await invoke({ tool: open_.list, threadId: open_.parent, input: {} })

    expect(outcome.ok && outcome.modelText).toContain('mine')
    expect(outcome.ok && outcome.modelText).not.toContain('theirs')
  })

  it('reads the same while a child works, so a second call rewards nothing', async () => {
    const open_ = await open()
    await invoke({
      tool: open_.spawn,
      threadId: open_.parent,
      input: { agentType: 'explore', intent: 'mine', brief: 'do mine' },
    })

    const before = await invoke({ tool: open_.list, threadId: open_.parent, input: {} })
    open_.runners.started[0]?.observe(said('halfway there'))
    const after = await invoke({ tool: open_.list, threadId: open_.parent, input: {} })

    expect(before.ok && before.modelText).toContain('is still running')
    expect(before.ok && before.modelText).not.toContain('turn')
    expect(after.ok && after.modelText).toBe(before.ok ? before.modelText : '')
  })

  it('still counts the work a child did once it has ended, where the count is the report', async () => {
    const open_ = await open()
    await invoke({
      tool: open_.spawn,
      threadId: open_.parent,
      input: { agentType: 'explore', intent: 'mine', brief: 'do mine' },
    })

    open_.runners.started[0]?.observe(said('halfway there'))
    open_.runners.started[0]?.settle(finished())
    await settle()
    const outcome = await invoke({ tool: open_.list, threadId: open_.parent, input: {} })

    expect(outcome.ok && outcome.modelText).toContain('finished after 1 turn')
  })

  it('says plainly that nothing has been started', async () => {
    const open_ = await open()

    const outcome = await invoke({ tool: open_.list, threadId: open_.parent, input: {} })

    expect(outcome.ok && outcome.modelText).toBe('You have started no sub-agents.')
  })
})

describe('agent_say', () => {
  it('queues a message for a running child without starting a second turn', async () => {
    const open_ = await open()
    const agentId = spawnedId(
      await invoke({
        tool: open_.spawn,
        threadId: open_.parent,
        input: { agentType: 'explore', intent: 'mine', brief: 'do mine' },
      }),
    )

    const outcome = await invoke({
      tool: open_.say,
      threadId: open_.parent,
      input: { agentId, text: 'look at the other file instead' },
    })

    expect(outcome.ok && outcome.modelText).toContain('queued')
    expect(open_.runners.started).toHaveLength(1)
    expect(open_.runners.started[0]?.request.steering()).toEqual(['look at the other file instead'])
  })

  it('runs a stopped child again on what it was told', async () => {
    const open_ = await open()
    const agentId = spawnedId(
      await invoke({
        tool: open_.spawn,
        threadId: open_.parent,
        input: { agentType: 'explore', intent: 'mine', brief: 'do mine' },
      }),
    )
    open_.runners.started[0]?.settle(finished())
    await settle()

    const outcome = await invoke({
      tool: open_.say,
      threadId: open_.parent,
      input: { agentId, text: 'now do the second half' },
    })

    expect(outcome.ok && outcome.modelText).toContain('running again')
    expect(open_.runners.started).toHaveLength(2)
  })

  it('refuses an agentId this thread never started, naming the ones it did', async () => {
    const open_ = await open()
    const agentId = spawnedId(
      await invoke({
        tool: open_.spawn,
        threadId: open_.parent,
        input: { agentType: 'explore', intent: 'mine', brief: 'do mine' },
      }),
    )

    const outcome = await invoke({
      tool: open_.say,
      threadId: open_.parent,
      input: { agentId: 'brn_nobody', text: 'hello' },
    })

    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.reason).toContain('brn_nobody')
    expect(!outcome.ok && outcome.reason).toContain(agentId)
  })
})

describe('agent_resume', () => {
  it('re-runs a child that stopped, appending nothing to its conversation', async () => {
    const open_ = await open()
    const agentId = spawnedId(
      await invoke({
        tool: open_.spawn,
        threadId: open_.parent,
        input: { agentType: 'explore', intent: 'mine', brief: 'do mine' },
      }),
    )
    const before = (await open_.harness.log.readOwn({ threadId: agentId })).length
    open_.runners.started[0]?.settle(finished())
    await settle()

    const outcome = await invoke({ tool: open_.resume, threadId: open_.parent, input: { agentId } })

    expect(outcome.ok).toBe(true)
    expect(open_.runners.resumed).toEqual([agentId])
    expect(await open_.harness.log.readOwn({ threadId: agentId })).toHaveLength(before)
  })

  it('refuses an agentId this thread never started', async () => {
    const open_ = await open()

    const outcome = await invoke({
      tool: open_.resume,
      threadId: open_.parent,
      input: { agentId: 'brn_nobody' },
    })

    expect(outcome.ok).toBe(false)
  })
})

describe('agent_stop', () => {
  it('interrupts the child, which its runner sees on the signal it was handed', async () => {
    const open_ = await open()
    const agentId = spawnedId(
      await invoke({
        tool: open_.spawn,
        threadId: open_.parent,
        input: { agentType: 'explore', intent: 'mine', brief: 'do mine' },
      }),
    )

    const outcome = await invoke({ tool: open_.stop, threadId: open_.parent, input: { agentId } })

    expect(outcome.ok).toBe(true)
    expect(open_.runners.started[0]?.signal.aborted).toBe(true)
  })

  it('names what it requested, never an attribution the child has not settled into', async () => {
    const open_ = await open()
    const agentId = spawnedId(
      await invoke({
        tool: open_.spawn,
        threadId: open_.parent,
        input: { agentType: 'explore', intent: 'mine', brief: 'do mine' },
      }),
    )

    const outcome = await invoke({ tool: open_.stop, threadId: open_.parent, input: { agentId } })
    if (!outcome.ok) throw new Error(outcome.reason)

    expect(outcome.output).toMatchObject({ stopRequestedBy: EKilledBy.Model })
    expect(outcome.output).not.toHaveProperty('killedBy')
  })

  it('hands back the real attribution once the child has settled into one', async () => {
    const open_ = await open()
    const agentId = spawnedId(
      await invoke({
        tool: open_.spawn,
        threadId: open_.parent,
        input: { agentType: 'explore', intent: 'mine', brief: 'do mine' },
      }),
    )
    await settle()
    open_.supervisor.stop({ agentId, threadId: open_.parent, by: EKilledBy.User })
    open_.runners.started[0]?.settle(interrupted())
    await open_.supervisor.closeAll()

    const outcome = await invoke({ tool: open_.stop, threadId: open_.parent, input: { agentId } })
    if (!outcome.ok) throw new Error(outcome.reason)

    expect(outcome.output).toMatchObject({ killedBy: EKilledBy.User })
    expect(outcome.output).not.toHaveProperty('stopRequestedBy')
    expect(outcome.modelText).toContain('was stopped by the user')
  })

  it('cannot reach a sibling, because the registry scopes every read to the owner', async () => {
    const open_ = await open()
    const stranger = (await open_.harness.threads.create({})).id
    const theirs = spawnedId(
      await invoke({
        tool: open_.spawn,
        threadId: stranger,
        input: { agentType: 'builder', intent: 'theirs', brief: 'do theirs' },
      }),
    )

    const outcome = await invoke({
      tool: open_.stop,
      threadId: open_.parent,
      input: { agentId: theirs },
    })

    expect(outcome.ok).toBe(false)
    expect(open_.runners.started[0]?.signal.aborted).toBe(false)
  })
})
