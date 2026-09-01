import { toRunId, toThreadId } from '@dltech/atlas-core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { NO_THREADS, THREADS_HEADING } from '../../ui/components/threads'
import { App } from '../app'
import { FAKE_CONFIG, fakeApp, scriptedModelPort, type FakeApp } from './fake-app'

await grammarsReady()

const THREAD = toThreadId('opened-thread')

const WIDE = { width: 150, height: 40 }

type Mounted = Awaited<ReturnType<typeof testRender>>

const appWith = (): FakeApp =>
  fakeApp({ model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }) })

async function seed(args: { app: FakeApp; title: string; said: string }): Promise<string> {
  const thread = await args.app.threads.create({ workspace: FAKE_CONFIG.cwd, repo: null })
  await args.app.threads.rename({ threadId: thread.id, title: args.title })
  await args.app.log.append({
    threadId: thread.id,
    runId: toRunId(`run-${args.title}`),
    drafts: [{ type: 'user-said', text: args.said }],
  })

  return thread.id
}

async function opened(app: FakeApp): Promise<Mounted> {
  const setup = await testRender(
    <App app={app} opened={{ threadId: THREAD, events: [], turns: [], name: null, started: true }} />,
    WIDE,
  )
  await setup.flush()
  await settle(250)
  await setup.flush()
  return setup
}

async function ran(setup: Mounted, typed: string): Promise<void> {
  await setup.mockInput.typeText(typed)
  await setup.flush()
  setup.mockInput.pressEnter()
  await setup.flush()
  await settle(250)
  await setup.flush()
}

describe('/resume', () => {
  it('is offered by the command menu as you type it', async () => {
    const setup = await opened(appWith())

    try {
      await setup.mockInput.typeText('/resu')
      await settle(60)
      await setup.flush()

      expect(setup.captureCharFrame()).toContain('resume')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('lists the other conversations in this workspace, by title', async () => {
    const app = appWith()
    await seed({ app, title: 'the auth overlay', said: 'wire up accounts' })
    const setup = await opened(app)

    try {
      await ran(setup, '/resume')

      const frame = setup.captureCharFrame()
      expect(frame).toContain(THREADS_HEADING.toUpperCase())
      expect(frame).toContain('the auth overlay')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('says so when the workspace holds nothing else', async () => {
    const setup = await opened(appWith())

    try {
      await ran(setup, '/resume')

      expect(setup.captureCharFrame()).toContain(NO_THREADS)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('swaps the transcript for the picked conversation', async () => {
    const app = appWith()
    await seed({ app, title: 'the auth overlay', said: 'wire up accounts' })
    const setup = await opened(app)

    try {
      await ran(setup, '/resume')
      setup.mockInput.pressEnter()
      await setup.flush()
      await settle(400)
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).toContain('wire up accounts')
      expect(frame).not.toContain(THREADS_HEADING.toUpperCase())
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('filters the list as you type', async () => {
    const app = appWith()
    await seed({ app, title: 'the auth overlay', said: 'wire up accounts' })
    await seed({ app, title: 'shell teardown', said: 'kill the strays' })
    const setup = await opened(app)

    try {
      await ran(setup, '/resume')
      await setup.mockInput.typeText('shell')
      await settle(120)
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).toContain('shell teardown')
      expect(frame).not.toContain('the auth overlay')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('goes straight to a conversation named by its handle, without the picker', async () => {
    const app = appWith()
    await seed({ app, title: 'the auth overlay', said: 'wire up accounts' })
    const setup = await opened(app)

    try {
      await ran(setup, '/resume the-auth-overlay')

      const frame = setup.captureCharFrame()
      expect(frame).toContain('wire up accounts')
      expect(frame).not.toContain(THREADS_HEADING.toUpperCase())
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('says so when the handle names no conversation here', async () => {
    const app = appWith()
    await seed({ app, title: 'the auth overlay', said: 'wire up accounts' })
    const setup = await opened(app)

    try {
      await ran(setup, '/resume no-such-conversation')

      expect(setup.captureCharFrame()).toContain('no-such-conversation')
      expect(setup.captureCharFrame()).not.toContain('wire up accounts')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('closes on escape without changing the conversation', async () => {
    const app = appWith()
    await seed({ app, title: 'the auth overlay', said: 'wire up accounts' })
    const setup = await opened(app)

    try {
      await ran(setup, '/resume')
      setup.mockInput.pressEscape()
      await setup.flush()
      await settle(200)
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).not.toContain(THREADS_HEADING.toUpperCase())
      expect(frame).not.toContain('wire up accounts')
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})
