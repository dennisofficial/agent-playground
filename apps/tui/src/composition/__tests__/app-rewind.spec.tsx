import { toThreadId } from '@dltech/atlas-core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { App } from '../app'
import { fakeApp, scriptedModelPort, type FakeApp } from './fake-app'

await grammarsReady()

const THREAD = toThreadId('opened-thread')

const WIDE = { width: 150, height: 40 }

type Mounted = Awaited<ReturnType<typeof testRender>>

const appWith = (): FakeApp =>
  fakeApp({
    model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }),
    summarises: 'the earlier work, summarised',
  })

async function opened(app: FakeApp): Promise<Mounted> {
  const setup = await testRender(
    <App app={app} opened={{ threadId: THREAD, events: [], name: null }} />,
    WIDE,
  )
  await setup.flush()
  await settle(250)
  await setup.flush()
  return setup
}

async function said(setup: Mounted, text: string): Promise<void> {
  await setup.mockInput.typeText(text)
  await settle(60)
  await setup.flush()
  setup.mockInput.pressEnter()
  await settle(1_500)
  await setup.flush()
}

describe('the rewind command', () => {
  it('offers the messages the operator sent, newest first', async () => {
    const setup = await opened(appWith())

    try {
      await said(setup, 'build the parser')
      await said(setup, 'now the lexer')

      await said(setup, '/rewind')

      const frame = setup.captureCharFrame()
      expect(frame).toContain('Rewind the conversation to an earlier point')
      expect(frame).toContain('now the lexer')
      expect(frame).toContain('build the parser')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('does not open on a conversation nobody has spoken into', async () => {
    const setup = await opened(appWith())

    try {
      await said(setup, '/rewind')

      expect(setup.captureCharFrame()).not.toContain('Rewind the conversation to an earlier point')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('takes the chosen message back into the composer when rewinding to it', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      await said(setup, 'build the parser')
      await said(setup, 'now the lexer')
      await said(setup, '/rewind')

      setup.mockInput.pressEnter()
      await settle(200)
      await setup.flush()

      expect(setup.captureCharFrame()).toContain('rewind to here')

      setup.mockInput.pressEnter()
      await settle(1_500)
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).not.toContain('Rewind the conversation to an earlier point')
      expect(frame).toContain('now the lexer')
      expect(await app.log.read({ threadId: THREAD })).toHaveLength(2)
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})

describe('the compact command', () => {
  it('compacts an ordinary short conversation rather than deciding there is nothing to do', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      await said(setup, 'build the parser')
      await said(setup, 'now the lexer')
      await said(setup, '/compact')
      await settle(1_500)
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).toContain('context compacted')
      expect(frame).not.toContain('nothing worth compacting')
      expect(frame).not.toContain('failed')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('says nothing at all when there is genuinely nothing to compact', async () => {
    const setup = await opened(appWith())

    try {
      await said(setup, '/compact')
      await settle(500)
      await setup.flush()

      expect(setup.captureCharFrame()).not.toContain('failed')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('refuses an argument it does not understand, and says so', async () => {
    const setup = await opened(appWith())

    try {
      await said(setup, 'build the parser')
      await said(setup, '/compact sideways')

      expect(setup.captureCharFrame()).toContain('not sideways')
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})

describe('while a compaction is running', () => {
  const slow = (): FakeApp =>
    fakeApp({
      model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }),
      summarises: 'the earlier work, summarised',
      summariseDelayMs: 4_000,
    })

  it('says it is compacting, and offers a way out', async () => {
    const setup = await opened(slow())

    try {
      await said(setup, 'build the parser')
      await said(setup, 'now the lexer')

      await setup.mockInput.typeText('/compact')
      await settle(60)
      await setup.flush()
      setup.mockInput.pressEnter()
      await settle(600)
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).toContain('Compacting for')
      expect(frame).toContain('esc to interrupt')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('stops when interrupted, leaving the history alone', async () => {
    const app = slow()
    const setup = await opened(app)

    try {
      await said(setup, 'build the parser')
      await said(setup, 'now the lexer')
      const before = (await app.log.read({ threadId: THREAD })).length

      await setup.mockInput.typeText('/compact')
      await settle(60)
      await setup.flush()
      setup.mockInput.pressEnter()
      await settle(600)
      await setup.flush()

      setup.mockInput.pressEscape()
      await settle(1_000)
      await setup.flush()

      expect(setup.captureCharFrame()).not.toContain('Compacting for')
      expect(await app.log.read({ threadId: THREAD })).toHaveLength(before)
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})

describe('the compaction clock', () => {
  it('counts up from zero even when the conversation sat idle first', async () => {
    const setup = await opened(
      fakeApp({
        model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }),
        summarises: 'the earlier work, summarised',
        summariseDelayMs: 3_000,
      }),
    )

    try {
      await said(setup, 'build the parser')
      await said(setup, 'now the lexer')
      await settle(1_200)
      await setup.flush()

      await setup.mockInput.typeText('/compact')
      await settle(60)
      await setup.flush()
      setup.mockInput.pressEnter()
      await settle(700)
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).toContain('Compacting for')
      expect(frame).not.toContain('for -')
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})

