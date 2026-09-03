import { toRunId, toThreadId } from '@dltech/atlas-core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { App } from '../app'
import { FAKE_CONFIG, fakeApp, scriptedModelPort, type FakeApp } from './fake-app'

await grammarsReady()

const TREE = '/work/atlas/.claude/worktrees/thing'

const WIDE = { width: 150, height: 40 }

const appWith = (): FakeApp =>
  fakeApp({ model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }) })

async function seedWorktreeThread(args: { app: FakeApp; title: string }): Promise<string> {
  const thread = await args.app.threads.create({ workspace: FAKE_CONFIG.cwd, repo: null })
  await args.app.threads.rename({ threadId: thread.id, title: args.title })
  await args.app.log.append({
    threadId: thread.id,
    runId: toRunId(`run-${args.title}`),
    drafts: [
      { type: 'user-said', text: 'set up the thing' },
      { type: 'worktree-entered', path: TREE, branch: 'dennis/thing', base: 'origin/main' },
    ],
  })

  return thread.id
}

describe('the app announcing which directory an opened conversation stands in', () => {
  it('announces the worktree of a thread resumed at boot, before any turn runs', async () => {
    const app = appWith()
    const threadId = toThreadId(await seedWorktreeThread({ app, title: 'the thing' }))
    const events = await app.log.read({ threadId })

    const setup = await testRender(
      <App app={app} opened={{ threadId, events, turns: [], name: 'the thing', started: true }} />,
      WIDE,
    )

    try {
      await settle(250)
      await setup.flush()

      expect(app.openedDirectories).toEqual([TREE])
      expect(app.turnsDriven).toBe(0)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('announces the launch directory for a conversation nobody has spoken in', async () => {
    const app = appWith()
    const setup = await testRender(
      <App
        app={app}
        opened={{ threadId: toThreadId('fresh'), events: [], turns: [], name: null, started: false }}
      />,
      WIDE,
    )

    try {
      await settle(250)
      await setup.flush()

      expect(app.openedDirectories).toEqual([FAKE_CONFIG.cwd])
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('follows a switch into a thread standing in a worktree', async () => {
    const app = appWith()
    await seedWorktreeThread({ app, title: 'the thing' })
    const setup = await testRender(
      <App
        app={app}
        opened={{ threadId: toThreadId('opened-thread'), events: [], turns: [], name: null, started: true }}
      />,
      WIDE,
    )

    try {
      await settle(250)
      await setup.flush()
      expect(app.openedDirectories).toEqual([FAKE_CONFIG.cwd])

      await setup.mockInput.typeText('/resume the-thing')
      await setup.flush()
      setup.mockInput.pressEnter()
      await setup.flush()
      await settle(400)
      await setup.flush()

      expect(app.openedDirectories).toEqual([FAKE_CONFIG.cwd, TREE])
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})
