import { EAgentStatus, toRunId, toThreadId } from '@dltech/atlas-core'
import { EKilledBy } from '@dltech/atlas-harness'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React, { act } from 'react'

import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { SIDEBAR_WIDTH } from '../../ui/theme'
import { App } from '../app'
import { FAKE_CONFIG, fakeApp, scriptedModelPort, type FakeApp } from './fake-app'
import { fakeAgentSnapshot } from './fake-agents'

await grammarsReady()

const THREAD = toThreadId('opened-thread')

const CHILD = toThreadId('thr_child')

const CHILD_INTENT = 'vault audit'

const CHILD_SAID = 'The vault reads its key file exactly once.'

const CHILD_LATER = 'And the rotation path never reads it twice.'

const PARENT_SAID = 'Please delegate the credential sweep.'

const STEERING = 'Steer the turn'

const ADDRESSING = 'Message this sub-agent'

const RETIRED = 'that agent type is no longer defined'

const SECOND_CHILD = toThreadId('thr_child_two')

const SECOND_INTENT = 'rotation sweep'

const SECOND_SAID = 'The rotation path holds no key of its own.'

const WIDE = { width: 150, height: 40, exitOnCtrlC: false }

type Mounted = Awaited<ReturnType<typeof testRender>>

const appWith = (): FakeApp =>
  fakeApp({ model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }) })

const child = (over: { status?: EAgentStatus } = {}) =>
  fakeAgentSnapshot({ agentId: CHILD, spawnedBy: THREAD, intent: CHILD_INTENT, ...over })

async function seed(app: FakeApp): Promise<void> {
  await app.log.append({
    threadId: THREAD,
    runId: toRunId('run-parent'),
    drafts: [{ type: 'user-said', text: PARENT_SAID }],
  })
  await app.log.append({
    threadId: CHILD,
    runId: toRunId('run-child'),
    drafts: [{ type: 'user-said', text: CHILD_SAID }],
  })
}

async function opened(app: FakeApp): Promise<Mounted> {
  const events = await app.log.read({ threadId: THREAD })
  const setup = await testRender(
    <App app={app} opened={{ threadId: THREAD, events, turns: [], name: 'the parent', started: true }} />,
    WIDE,
  )
  await setup.flush()
  await settle(250)
  await setup.flush()
  return setup
}

/**
 * Found by where it sits rather than by what it says: the child's intent also reaches the transcript
 * once an ending is announced, and the row's own reading changes with what the child is doing.
 */
const sidebarRowOf = (setup: Mounted, needle: string): number =>
  setup
    .captureCharFrame()
    .split('\n')
    .findIndex((line) => line.indexOf(needle) >= WIDE.width - SIDEBAR_WIDTH)

async function pressChord(setup: Mounted, key: string): Promise<void> {
  setup.mockInput.pressKey(key, { ctrl: true })
  await setup.flush()
  await settle(250)
  await setup.flush()
}

async function selectChild(setup: Mounted): Promise<void> {
  const row = sidebarRowOf(setup, CHILD_INTENT)
  expect(row).toBeGreaterThan(-1)

  setup.mockMouse.click(WIDE.width - 10, row)
  await setup.flush()
  await settle(250)
  await setup.flush()
}

describe('viewing a sub-agent', () => {
  it('switches the transcript to the child and leaves the parent out of it', async () => {
    const app = appWith()
    await seed(app)
    app.agents.place(child())
    const setup = await opened(app)

    try {
      expect(setup.captureCharFrame()).toContain(PARENT_SAID)

      await selectChild(setup)

      const frame = setup.captureCharFrame()
      expect(frame).toContain(CHILD_SAID)
      expect(frame).not.toContain(PARENT_SAID)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('leaves the sidebar anchored to the parent, title, sections and list alike', async () => {
    const app = appWith()
    await seed(app)
    app.agents.place(child())
    const setup = await opened(app)

    try {
      const before = setup.captureCharFrame()
      expect(before).toContain('the parent')

      await selectChild(setup)

      const after = setup.captureCharFrame()
      expect(after).toContain('the parent')
      expect(after).toContain('SUBAGENTS  1/1')
      expect(after).toContain(CHILD_INTENT)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('never swaps the thread, which is what made it read as another session', async () => {
    const app = appWith()
    await seed(app)
    app.agents.place(child())
    const setup = await opened(app)

    try {
      const marked = app.activeThread()?.threadId
      await selectChild(setup)

      expect(app.activeThread()?.threadId).toBe(marked)
      expect(setup.captureCharFrame()).not.toContain('no conversation')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('leaves the background wait with the parent, whose turn is the one still waiting', async () => {
    const app = appWith()
    await seed(app)
    app.agents.place(child())
    const setup = await opened(app)

    try {
      expect(setup.captureCharFrame()).toContain('1 background agent to finish')

      await selectChild(setup)

      expect(setup.captureCharFrame()).not.toContain('background agent')

      setup.mockInput.pressEscape()
      await setup.flush()
      await settle(250)
      await setup.flush()

      expect(setup.captureCharFrame()).toContain('1 background agent to finish')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('addresses the child in the composer', async () => {
    const app = appWith()
    await seed(app)
    app.agents.place(child())
    const setup = await opened(app)

    try {
      await selectChild(setup)

      expect(setup.captureCharFrame()).toContain(`@${CHILD_INTENT}`)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('sends what the operator types to the child rather than to the parent', async () => {
    const app = appWith()
    await seed(app)
    app.agents.place(child())
    const setup = await opened(app)

    try {
      await selectChild(setup)

      await setup.mockInput.typeText('keep going')
      await setup.flush()
      setup.mockInput.pressEnter()
      await setup.flush()
      await settle(250)
      await setup.flush()

      expect(app.agents.said).toEqual([{ agentId: CHILD, threadId: THREAD, text: 'keep going' }])
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('comes back to the parent on escape', async () => {
    const app = appWith()
    await seed(app)
    app.agents.place(child())
    const setup = await opened(app)

    try {
      await selectChild(setup)
      expect(setup.captureCharFrame()).toContain(CHILD_SAID)

      setup.mockInput.pressEscape()
      await setup.flush()
      await settle(250)
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).toContain(PARENT_SAID)
      expect(frame).not.toContain(CHILD_SAID)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  /**
   * A child publishes on the delta channel under its own thread id, exactly as the root thread
   * does, so the transcript follows it the same way the conversation follows a turn — off the
   * channel rather than off a re-read triggered by the roster settling.
   */
  it('follows a working child as it appends, with no timer', async () => {
    const app = appWith()
    await seed(app)
    app.agents.place(child())
    const setup = await opened(app)

    try {
      await selectChild(setup)
      expect(setup.captureCharFrame()).not.toContain(CHILD_LATER)

      await app.log.append({
        threadId: CHILD,
        runId: toRunId('run-child-2'),
        drafts: [{ type: 'assistant-said', parts: [{ type: 'text', text: CHILD_LATER }] }],
      })
      act(() => {
        app.channel.publisherFor({ threadId: CHILD }).settleAppend({ events: [] })
        app.agents.progressed({ agentId: CHILD })
      })
      await setup.flush()
      await settle(250)
      await setup.flush()

      expect(setup.captureCharFrame()).toContain(CHILD_LATER)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('keeps an ended child readable, because its log is the point of a done row', async () => {
    const app = appWith()
    await seed(app)
    app.agents.place(child())
    const setup = await opened(app)

    try {
      act(() => app.agents.end({ agentId: CHILD }))
      await setup.flush()
      await settle(250)
      await setup.flush()

      await selectChild(setup)

      expect(setup.captureCharFrame()).toContain(CHILD_SAID)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('says what enter will do, and keeps the parent turn in flight behind it', async () => {
    const app = fakeApp({
      model: scriptedModelPort({
        script: { thinking: 'weighing it at length', reply: 'still going on and on' },
        perChunkMs: 200,
      }),
    })
    await seed(app)
    app.agents.place(child())
    const setup = await opened(app)

    try {
      await setup.mockInput.typeText('go')
      await setup.flush()
      setup.mockInput.pressEnter()
      await setup.flush()
      await settle(200)
      await setup.flush()

      expect(setup.captureCharFrame()).toContain(STEERING)

      await selectChild(setup)

      const frame = setup.captureCharFrame()
      expect(frame).toContain(CHILD_SAID)
      expect(frame).not.toContain(STEERING)
      expect(frame).toContain(ADDRESSING)

      setup.mockInput.pressEscape()
      await setup.flush()
      await settle(200)
      await setup.flush()

      expect(setup.captureCharFrame()).toContain(STEERING)
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})

describe('a child that refuses what the operator typed', () => {
  it('hands the message back and says why, rather than swallowing both', async () => {
    const app = appWith()
    await seed(app)
    app.agents.place(child())
    const setup = await opened(app)

    try {
      await selectChild(setup)
      app.agents.refuseSay(RETIRED)

      await setup.mockInput.typeText('keep going')
      await setup.flush()
      setup.mockInput.pressEnter()
      await setup.flush()
      await settle(250)
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(app.agents.said).toEqual([])
      expect(frame).toContain('keep going')
      expect(frame).toContain(RETIRED)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('comes back to the parent, where the reason it gave is on screen', async () => {
    const app = appWith()
    await seed(app)
    app.agents.place(child())
    const setup = await opened(app)

    try {
      await selectChild(setup)
      app.agents.refuseSay(RETIRED)

      await setup.mockInput.typeText('keep going')
      await setup.flush()
      setup.mockInput.pressEnter()
      await setup.flush()
      await settle(250)
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).toContain(PARENT_SAID)
      expect(frame).not.toContain(CHILD_SAID)
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})

describe('reaching a sub-agent without the mouse', () => {
  it('walks into the crew and back out again on the same chord', async () => {
    const app = appWith()
    await seed(app)
    app.agents.place(child())
    const setup = await opened(app)

    try {
      await pressChord(setup, 'g')
      expect(setup.captureCharFrame()).toContain(CHILD_SAID)

      await pressChord(setup, 'g')
      const frame = setup.captureCharFrame()
      expect(frame).toContain(PARENT_SAID)
      expect(frame).not.toContain(CHILD_SAID)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('takes in every child before it hands the transcript back to the parent', async () => {
    const app = appWith()
    await seed(app)
    await app.log.append({
      threadId: SECOND_CHILD,
      runId: toRunId('run-child-two'),
      drafts: [{ type: 'user-said', text: SECOND_SAID }],
    })
    app.agents.place(child())
    app.agents.place(
      fakeAgentSnapshot({ agentId: SECOND_CHILD, spawnedBy: THREAD, intent: SECOND_INTENT }),
    )
    const setup = await opened(app)

    try {
      await pressChord(setup, 'g')
      expect(setup.captureCharFrame()).toContain(CHILD_SAID)

      await pressChord(setup, 'g')
      const second = setup.captureCharFrame()
      expect(second).toContain(SECOND_SAID)
      expect(second).toContain(`@${SECOND_INTENT}`)

      await pressChord(setup, 'g')
      expect(setup.captureCharFrame()).toContain(PARENT_SAID)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('stops the child the operator is reading, and says the operator did it', async () => {
    const app = appWith()
    await seed(app)
    app.agents.place(child())
    const setup = await opened(app)

    try {
      await pressChord(setup, 'g')

      const before = setup.captureCharFrame()
      expect(before).toContain(CHILD_SAID)
      expect(before).toContain('SUBAGENTS  1/1')
      expect(app.agents.stopped).toEqual([])

      await pressChord(setup, 'k')

      expect(app.agents.stopped).toEqual([{ agentId: CHILD, by: EKilledBy.User }])
      const after = setup.captureCharFrame()
      expect(after).toContain('SUBAGENTS  0/1')
      expect(after).toContain('stopped')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('keeps the stopped child on screen, because its log is what was cut short', async () => {
    const app = appWith()
    await seed(app)
    app.agents.place(child())
    const setup = await opened(app)

    try {
      await pressChord(setup, 'g')
      await pressChord(setup, 'k')

      const frame = setup.captureCharFrame()
      expect(frame).toContain(CHILD_SAID)
      expect(frame).not.toContain(PARENT_SAID)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('offers no stop on a child that already ended, where it would do nothing', async () => {
    const app = appWith()
    await seed(app)
    app.agents.place(child())
    const setup = await opened(app)

    try {
      await pressChord(setup, 'g')
      expect(setup.captureCharFrame()).toContain(CHILD_SAID)

      act(() => app.agents.end({ agentId: CHILD }))
      await setup.flush()
      await settle(250)
      await setup.flush()

      await pressChord(setup, 'k')

      expect(app.agents.stopped).toEqual([])
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('leaves escape owning the way back, so the chord never fights it', async () => {
    const app = appWith()
    await seed(app)
    app.agents.place(child())
    const setup = await opened(app)

    try {
      await pressChord(setup, 'g')
      expect(setup.captureCharFrame()).toContain(CHILD_SAID)

      setup.mockInput.pressEscape()
      await setup.flush()
      await settle(250)
      await setup.flush()

      expect(setup.captureCharFrame()).toContain(PARENT_SAID)
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})
