import { EAgentStatus, EDefinitionOrigin, toCallId, toRunId, toThreadId } from '@dltech/atlas-core'
import {
  EAgentTypeRefusal,
  EKilledBy,
  type AgentTypeCatalog,
  type RecoveredAgents,
} from '@dltech/atlas-harness'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React, { act } from 'react'

import { HEADING } from '../../ui/components/exit-guard'
import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { App } from '../app'
import { FAKE_CONFIG, fakeApp, scriptedModelPort, type FakeApp } from './fake-app'
import { fakeAgentSnapshot } from './fake-agents'

await grammarsReady()

const THREAD = toThreadId('opened-thread')

const CHILD = toThreadId('thr_child')

const CHILD_INTENT = 'vault audit'

const CHILD_SAID = 'The vault reads its key file exactly once.'

const SETTLED_CHILD = toThreadId('thr_settled')

const SETTLED_INTENT = 'rotation sweep'

const PARENT_SAID = 'Delegate the vault audit please.'

const WIDE = { width: 150, height: 40, exitOnCtrlC: false }

type Mounted = Awaited<ReturnType<typeof testRender>>

const REVIEWER_DETAIL = '"Reviewer" cannot name an agent type'

const CATALOG: AgentTypeCatalog = {
  types: [
    {
      name: 'explore',
      whenToUse: 'sweep the tree for a thing',
      prompt: 'go and look',
      origin: EDefinitionOrigin.BuiltIn,
    },
  ],
  refusals: [
    {
      refusal: EAgentTypeRefusal.BadName,
      name: 'Reviewer',
      definedIn: '/work/project/.atlas/agents/Reviewer.md',
      origin: EDefinitionOrigin.Project,
      detail: `${REVIEWER_DETAIL}: it must be lower case`,
    },
  ],
  shadowed: [
    {
      name: 'explore',
      origin: EDefinitionOrigin.User,
      definedIn: '/work/home/.atlas/agents/explore.md',
      shadowedBy: EDefinitionOrigin.Project,
    },
  ],
}

const appWith = (): FakeApp =>
  fakeApp({ model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }) })

const child = (
  over: { turns?: number; toolCalls?: number; status?: EAgentStatus; lastTool?: string } = {},
) =>
  fakeAgentSnapshot({
    agentId: CHILD,
    spawnedBy: THREAD,
    intent: CHILD_INTENT,
    ...over,
  })

const settledChild = (status: EAgentStatus) =>
  fakeAgentSnapshot({
    agentId: SETTLED_CHILD,
    spawnedBy: THREAD,
    intent: SETTLED_INTENT,
    status,
  })

async function seedChildThread(app: FakeApp): Promise<void> {
  await app.threads.create({
    workspace: FAKE_CONFIG.cwd,
    repo: null,
    agent: { spawnedBy: THREAD, type: 'explore' },
  })
  const made = (await app.threads.list({ workspace: FAKE_CONFIG.cwd })).at(0)
  if (made === undefined) throw new Error('the child thread was not created')

  await app.threads.rename({ threadId: made.id, title: CHILD_INTENT })
  await app.log.append({
    threadId: made.id,
    runId: toRunId('run-child'),
    drafts: [{ type: 'user-said', text: CHILD_SAID }],
  })
}

/**
 * The log is seeded rather than the props alone: a refresh reads the store, so a conversation that
 * exists only in `opened.events` empties out mid-test and falls back to the welcome screen.
 */
async function opened(app: FakeApp): Promise<Mounted> {
  const events = await app.log.append({
    threadId: THREAD,
    runId: toRunId('run-before'),
    drafts: [{ type: 'user-said', text: 'what is in here?' }],
  })
  const setup = await testRender(
    <App app={app} opened={{ threadId: THREAD, events, turns: [], name: null, started: true }} />,
    WIDE,
  )
  await setup.flush()
  await settle(250)
  await setup.flush()
  return setup
}

describe('a sub-agent in the sidebar', () => {
  it('appears the moment it is spawned, with no interval to wait out', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      expect(setup.captureCharFrame()).not.toContain(CHILD_INTENT)

      act(() => app.agents.place(child()))
      await setup.flush()

      expect(setup.captureCharFrame()).toContain(CHILD_INTENT)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it("counts the child's own turns and tool calls, never the conversation it was spawned from", async () => {
    const app = appWith()
    await app.log.append({
      threadId: THREAD,
      runId: toRunId('run-parent'),
      drafts: [
        { type: 'user-said', text: 'audit the vault' },
        { type: 'user-said', text: 'and the key file' },
        { type: 'tool-called', callId: toCallId('call_parent'), name: 'read', ordinal: 0 },
      ],
    })
    app.agents.place(child({ turns: 2, toolCalls: 7, lastTool: 'grep' }))

    const setup = await opened(app)

    try {
      expect(setup.captureCharFrame()).toContain('grep · ')

      act(() => app.agents.end({ agentId: CHILD }))
      await setup.flush()

      expect(setup.captureCharFrame()).toContain('done · 7 calls')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('stops being live work the moment it ends, without a timer', async () => {
    const app = appWith()
    app.agents.place(child())
    const setup = await opened(app)

    try {
      expect(setup.captureCharFrame()).toContain('SUBAGENTS  1/1')

      act(() => app.agents.end({ agentId: CHILD }))
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).toContain('SUBAGENTS  0/1')
      expect(frame).toContain(`${CHILD_INTENT}`)
      expect(frame).toContain('done')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('reads how full a child window is off the snapshot the registry already sends', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      expect(setup.captureCharFrame()).not.toContain('ctx 34%')

      act(() => app.agents.place({ ...child(), context: { tokens: 68_000, window: 200_000 } }))
      await setup.flush()

      expect(setup.captureCharFrame()).toContain('ctx 34%')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('does not show a child to a conversation that did not spawn it', async () => {
    const app = appWith()
    app.agents.place(fakeAgentSnapshot({ agentId: CHILD, spawnedBy: CHILD, intent: CHILD_INTENT }))
    const setup = await opened(app)

    try {
      expect(setup.captureCharFrame()).not.toContain(CHILD_INTENT)
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})

describe('conversations the operator started', () => {
  it('leaves a sub-agent out of /resume', async () => {
    const app = appWith()
    await seedChildThread(app)
    const own = await app.threads.create({ workspace: FAKE_CONFIG.cwd, repo: null })
    await app.threads.rename({ threadId: own.id, title: 'a conversation I started' })

    const setup = await opened(app)

    try {
      await setup.mockInput.typeText('/resume')
      await setup.flush()
      setup.mockInput.pressEnter()
      await setup.flush()
      await settle(250)
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).toContain('a conversation I started')
      expect(frame).not.toContain(CHILD_INTENT)
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})

describe('leaving with a child still running', () => {
  it('names it the way the guard names a background shell', async () => {
    const app = appWith()
    app.agents.place(child())
    const setup = await opened(app)

    try {
      setup.mockInput.pressKey('c', { ctrl: true })
      await setup.flush()
      await settle(200)
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).toContain(HEADING)
      expect(frame).toContain('agent')
      expect(frame).toContain(CHILD_INTENT)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('stops warning once the child has ended', async () => {
    const app = appWith()
    app.agents.place(child())
    const setup = await opened(app)

    try {
      act(() => app.agents.end({ agentId: CHILD, status: EAgentStatus.Stopped }))
      await setup.flush()

      setup.mockInput.pressKey('c', { ctrl: true })
      await setup.flush()
      await settle(200)
      await setup.flush()

      expect(setup.captureCharFrame()).not.toContain(HEADING)
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})

describe('an ending is a wake, not an interrupt', () => {
  it('starts a turn on a parent that was sitting idle', async () => {
    const app = appWith()
    app.agents.place(child())
    const setup = await opened(app)

    try {
      expect(app.turnsDriven).toBe(0)

      act(() => app.agents.end({ agentId: CHILD }))
      await setup.flush()
      await settle(400)
      await setup.flush()

      expect(app.turnsDriven).toBe(1)
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})

describe('/agents types', () => {
  const catalogued = (): FakeApp =>
    fakeApp({
      model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }),
      agentTypes: CATALOG,
    })

  async function ask(setup: Mounted, text: string): Promise<void> {
    await setup.mockInput.typeText(text)
    await setup.flush()
    setup.mockInput.pressEnter()
    await setup.flush()
    await settle(250)
    await setup.flush()
  }

  it('puts the file that would not load on screen, with the reason and the path', async () => {
    const app = catalogued()
    const setup = await opened(app)

    try {
      expect(setup.captureCharFrame()).not.toContain('NOT LOADED')

      await ask(setup, '/agents types')

      const frame = setup.captureCharFrame()
      expect(frame).toContain('NOT LOADED')
      expect(frame).toContain('Reviewer')
      expect(frame).toContain('cannot name an agent type')
      expect(frame).toContain('Reviewer.md')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('puts the shadowed definition on screen with what displaced it', async () => {
    const app = catalogued()
    const setup = await opened(app)

    try {
      await ask(setup, '/agents types')

      const frame = setup.captureCharFrame()
      expect(frame).toContain('SHADOWED')
      expect(frame).toContain('explore.md')
      expect(frame).toContain('project one is loaded instead')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('puts the panel away on the next key, the way the shortcuts list goes away', async () => {
    const app = catalogued()
    const setup = await opened(app)

    try {
      await ask(setup, '/agents types')
      expect(setup.captureCharFrame()).toContain('NOT LOADED')

      setup.mockInput.pressEscape()
      await setup.flush()
      await settle(250)
      await setup.flush()

      expect(setup.captureCharFrame()).not.toContain('NOT LOADED')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('says what it takes when the argument is not one it knows', async () => {
    const app = catalogued()
    const setup = await opened(app)

    try {
      await ask(setup, '/agents kinds')

      const frame = setup.captureCharFrame()
      expect(frame).toContain('"types"')
      expect(frame).not.toContain('NOT LOADED')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('offers the running child rather than walking blindly into one', async () => {
    const app = catalogued()
    app.agents.place(child())
    const setup = await opened(app)

    try {
      await ask(setup, '/agents')

      const frame = setup.captureCharFrame()
      expect(frame).not.toContain('NOT LOADED')
      expect(frame).toContain('SUB-AGENTS')
      expect(frame).toContain(CHILD_INTENT)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('offers a child that has settled, saying what became of it', async () => {
    const app = catalogued()
    app.agents.place(settledChild(EAgentStatus.Failed))
    const setup = await opened(app)

    try {
      await ask(setup, '/agents')

      const frame = setup.captureCharFrame()
      expect(frame).toContain(SETTLED_INTENT)
      expect(frame).toContain('failed')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('reads the settled child the operator picks, the same as picking a running one', async () => {
    const app = catalogued()
    app.agents.place(child())
    app.agents.place(settledChild(EAgentStatus.Stopped))
    const setup = await opened(app)

    try {
      await ask(setup, '/agents')

      setup.mockInput.pressArrow('down')
      await setup.flush()
      setup.mockInput.pressEnter()
      await setup.flush()
      await settle(250)
      await setup.flush()

      expect(setup.captureCharFrame()).toContain(`@${SETTLED_INTENT}`)
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})

const ORPHAN = toThreadId('thr_orphan')

const ORPHAN_TITLE = 'explore (rotation sweep)'

const LOST: RecoveredAgents = {
  settled: [],
  unlogged: [
    {
      agentId: ORPHAN,
      agentType: 'explore',
      title: ORPHAN_TITLE,
      startedAt: '2026-01-01T09:15:00.000Z',
    },
  ],
}

async function openedWith(app: FakeApp, lost?: RecoveredAgents): Promise<Mounted> {
  const events = await app.log.append({
    threadId: THREAD,
    runId: toRunId('run-before'),
    drafts: [{ type: 'user-said', text: 'what is in here?' }],
  })
  const setup = await testRender(
    <App
      app={app}
      opened={{
        threadId: THREAD,
        events,
        turns: [],
        name: null,
        started: true,
        ...(lost === undefined ? {} : { lost }),
      }}
    />,
    WIDE,
  )
  await setup.flush()
  await settle(250)
  await setup.flush()
  return setup
}

describe('children the last process lost', () => {
  it('names an unlogged child on open, because nothing else in the app ever will', async () => {
    const setup = await openedWith(appWith(), LOST)

    try {
      const frame = setup.captureCharFrame()
      expect(frame).toContain(ORPHAN_TITLE)
      expect(frame).toContain('no record of')
      expect(frame).toContain('check the tree')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('says nothing was resumed, and resumes nothing', async () => {
    const app = appWith()
    const setup = await openedWith(app, LOST)

    try {
      expect(setup.captureCharFrame()).toContain('Nothing was resumed for you')
      expect(app.turnsDriven).toBe(0)
      expect(app.agents.said).toEqual([])
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('shows nothing at all on a clean open, which is every ordinary one', async () => {
    const setup = await openedWith(appWith())

    try {
      const frame = setup.captureCharFrame()
      expect(frame).not.toContain('no record of')
      expect(frame).not.toContain('check the tree')
      expect(frame).not.toContain('sub-agent')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('goes away on the next key and comes back on /agents lost', async () => {
    const setup = await openedWith(appWith(), LOST)

    try {
      expect(setup.captureCharFrame()).toContain(ORPHAN_TITLE)

      setup.mockInput.pressEscape()
      await setup.flush()
      await settle(250)
      await setup.flush()
      expect(setup.captureCharFrame()).not.toContain(ORPHAN_TITLE)

      await setup.mockInput.typeText('/agents lost')
      await setup.flush()
      setup.mockInput.pressEnter()
      await setup.flush()
      await settle(250)
      await setup.flush()

      expect(setup.captureCharFrame()).toContain(ORPHAN_TITLE)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('says so when /agents lost is asked of a conversation that lost nothing', async () => {
    const setup = await openedWith(appWith())

    try {
      await setup.mockInput.typeText('/agents lost')
      await setup.flush()
      setup.mockInput.pressEnter()
      await setup.flush()
      await settle(250)
      await setup.flush()

      expect(setup.captureCharFrame()).toContain('nothing was lost')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  /**
   * The other half of recovery needs no surface of its own: settling writes a real `agent-ended`
   * before the transcript is read, so the row is already in the conversation.
   */
  it('already reads a settled loss out of the transcript, with no notice needed', async () => {
    const app = appWith()
    await app.log.append({
      threadId: THREAD,
      runId: toRunId('run-parent'),
      drafts: [
        {
          type: 'agent-ended',
          agentId: CHILD,
          agentType: 'explore',
          intent: CHILD_INTENT,
          status: EAgentStatus.Stopped,
          killedBy: EKilledBy.Unrecorded,
          prose: 'it read three files',
          turns: 2,
          toolCalls: 7,
        },
      ],
    })

    const events = await app.log.read({ threadId: THREAD })
    const setup = await testRender(
      <App app={app} opened={{ threadId: THREAD, events, turns: [], name: null, started: true }} />,
      WIDE,
    )

    try {
      await setup.flush()
      await settle(250)
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).toContain('was lost before anything recorded how it ended')
      expect(frame).toContain('2 turns and 7 tool')
      expect(frame).not.toContain('no record of')
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})
