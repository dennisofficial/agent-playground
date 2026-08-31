import { afterEach, describe, expect, it } from 'bun:test'

import { defaultPipeline, EMPTY_PROMPT, type ThreadId } from '@dltech/atlas-core'

import { HookChain } from '../../../hooks/registry'
import { buildHarness } from '../../../loop/build-harness'
import { createTempDatabase } from '../../../loop/__tests__/temp-database'
import type { TurnDeps } from '../../../loop/run-turn'
import { scriptedModel } from '../../../model/testing/scripted-model'
import { InMemoryToolRegistry } from '../../../tools/registry'
import { childRunnerSource } from '../child-runner'
import { AgentSupervisor } from '../supervisor'
import { agentTypeNamed, openSupervisor, type OpenedSupervisor } from './fixtures'

const PROJECT_DIRECTORY = '/w'

const HAIKU_WINDOW = 200_000

const closers: (() => Promise<void>)[] = []

async function open(): Promise<OpenedSupervisor> {
  const supervisor = await openSupervisor()
  closers.push(supervisor.close)
  return supervisor
}

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

describe("a child's context reading", () => {
  it('lands on the child that took it and on no other', async () => {
    const { supervisor, runners, parent } = await open()
    const first = await supervisor.spawn({
      threadId: parent,
      agentType: 'explore',
      brief: 'look',
      intent: 'looking',
    })
    const second = await supervisor.spawn({
      threadId: parent,
      agentType: 'builder',
      brief: 'build',
      intent: 'building',
    })
    if (!first.ok || !second.ok) throw new Error('the spawns should have been accepted')

    runners.started[0]?.request.observeContext({ tokens: 12_000, window: 200_000 })

    const listed = supervisor.list({ threadId: parent })
    const reading = listed.find((agent) => agent.agentId === first.snapshot.agentId)?.context
    expect(reading).toEqual({ tokens: 12_000, window: 200_000 })
    expect(
      listed.find((agent) => agent.agentId === second.snapshot.agentId)?.context,
    ).toBeUndefined()
  })

  it('is a gauge and not a total, so the latest step replaces the one before it', async () => {
    const { supervisor, runners, parent } = await open()
    await supervisor.spawn({
      threadId: parent,
      agentType: 'explore',
      brief: 'look',
      intent: 'looking',
    })

    const observe = runners.started[0]?.request.observeContext
    observe?.({ tokens: 12_000, window: 200_000 })
    observe?.({ tokens: 31_000, window: 200_000 })

    expect(supervisor.list({ threadId: parent })[0]?.context).toEqual({
      tokens: 31_000,
      window: 200_000,
    })
  })

  it('carries the window of the step it measured, which a child may not share with its parent', async () => {
    const { supervisor, runners, parent } = await open()
    await supervisor.spawn({
      threadId: parent,
      agentType: 'explore',
      brief: 'look',
      intent: 'looking',
    })

    runners.started[0]?.request.observeContext({ tokens: 9_000, window: 1_000_000 })

    expect(supervisor.list({ threadId: parent })[0]?.context?.window).toBe(1_000_000)
  })

  it('repaints the sidebar, which reads the roster and nothing else', async () => {
    const { supervisor, runners, parent } = await open()
    await supervisor.spawn({
      threadId: parent,
      agentType: 'explore',
      brief: 'look',
      intent: 'looking',
    })

    let changes = 0
    supervisor.onChange(() => {
      changes += 1
    })

    runners.started[0]?.request.observeContext({ tokens: 12_000, window: 200_000 })

    expect(changes).toBe(1)
  })
})

describe('a child that has taken no step', () => {
  it('reports no reading at all, which is not a reading of zero', async () => {
    const { supervisor, parent } = await open()
    await supervisor.spawn({
      threadId: parent,
      agentType: 'explore',
      brief: 'look',
      intent: 'looking',
    })

    expect(supervisor.list({ threadId: parent })[0]?.context).toBeUndefined()
  })

  it('is distinguishable from a child whose assembly measured zero', async () => {
    const { supervisor, runners, parent } = await open()
    await supervisor.spawn({
      threadId: parent,
      agentType: 'explore',
      brief: 'look',
      intent: 'looking',
    })

    runners.started[0]?.request.observeContext({ tokens: 0, window: 200_000 })

    expect(supervisor.list({ threadId: parent })[0]?.context).toEqual({
      tokens: 0,
      window: 200_000,
    })
  })
})

type RealChild = {
  supervisor: AgentSupervisor
  parent: ThreadId
  parentTurn: TurnDeps
}

async function openRealChild(): Promise<RealChild> {
  const temp = createTempDatabase()
  const harness = await buildHarness({
    databaseUrl: temp.databaseUrl,
    model: scriptedModel({ script: [{ text: 'four call sites' }] }),
    identity: { id: 'anthropic', modelId: 'claude-haiku-4-5' },
  })

  const assembly = defaultPipeline({
    prompt: () => EMPTY_PROMPT,
    projectDirectory: PROJECT_DIRECTORY,
  })
  const parentTurn: TurnDeps = {
    log: harness.log,
    model: harness.model,
    ids: harness.ids,
    assembly,
    projectDirectory: PROJECT_DIRECTORY,
  }

  const supervisor = new AgentSupervisor({
    log: harness.log,
    threads: harness.threads,
    ids: harness.ids,
    clock: harness.clock,
    agentTypes: [agentTypeNamed({ name: 'explore' })],
    runners: childRunnerSource({
      deps: () => ({
        turn: parentTurn,
        tools: new InMemoryToolRegistry([]),
        hooks: new HookChain({}),
        drainNotices: async () => [],
        assemblyFor: () => assembly,
      }),
    }),
  })

  const parent = (await harness.threads.create({})).id
  const ended = new Promise<void>((resolve) => {
    const forget = supervisor.onNotice(() => {
      forget()
      resolve()
    })
  })

  const outcome = await supervisor.spawn({
    threadId: parent,
    agentType: 'explore',
    brief: 'count the call sites of assemble',
    intent: 'count assemble callers',
  })
  if (!outcome.ok) throw new Error(outcome.reason)
  await ended

  closers.push(async () => {
    await harness.close()
    temp.discard()
  })

  return { supervisor, parent, parentTurn }
}

describe('a child stepping against a real turn runner', () => {
  it('measures its own assembled prompt against its own window', async () => {
    const { supervisor, parent } = await openRealChild()

    const reading = supervisor.list({ threadId: parent })[0]?.context
    expect(reading?.window).toBe(HAIKU_WINDOW)
    expect(reading?.tokens).toBeGreaterThan(0)
  })

  it("leaves the parent's turn deps without an observer, so no reading can reach the parent's meter", async () => {
    const { parentTurn } = await openRealChild()

    expect(parentTurn.onContext).toBeUndefined()
    expect(Object.hasOwn(parentTurn, 'onContext')).toBe(false)
  })
})
