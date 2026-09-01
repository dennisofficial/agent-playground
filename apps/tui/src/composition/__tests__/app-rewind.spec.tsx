import { toThreadId } from '@dltech/atlas-core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { grammarsReady, teardown } from '../../ui/markdown/__tests__/harness'
import { frameShowing, frameWhen } from '../../ui/__tests__/waiting'
import { App } from '../app'
import { fakeApp, scriptedModelPort, type FakeApp } from './fake-app'

await grammarsReady()

const THREAD = toThreadId('opened-thread')

const WIDE = { width: 150, height: 40 }

const COMPOSER_IDLE = 'Ask anything'

const REWIND_TITLE = 'Rewind the conversation to an earlier point'

const COMPACTING = 'Compacting for'

type Mounted = Awaited<ReturnType<typeof testRender>>

const appWith = (): FakeApp =>
  fakeApp({
    model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }),
    summarises: 'the earlier work, summarised',
  })

async function opened(app: FakeApp): Promise<Mounted> {
  const setup = await testRender(
    <App app={app} opened={{ threadId: THREAD, events: [], turns: [], name: null, started: true }} />,
    WIDE,
  )
  await frameShowing({ setup, text: COMPOSER_IDLE })
  return setup
}

const saidOpening = async (setup: Mounted, text: string, opens: string): Promise<string> => {
  await said(setup, text, opens)
  return setup.captureCharFrame()
}

async function said(setup: Mounted, text: string, settlesOn = COMPOSER_IDLE): Promise<void> {
  await setup.mockInput.typeText(text)
  await frameShowing({ setup, text })
  setup.mockInput.pressEnter()
  await frameShowing({ setup, text: settlesOn })
}

describe('the rewind command', () => {
  it('offers the messages the operator sent, newest first', async () => {
    const setup = await opened(appWith())

    try {
      await said(setup, 'build the parser')
      await said(setup, 'now the lexer')

      const frame = await saidOpening(setup, '/rewind', REWIND_TITLE)
      expect(frame).toContain(REWIND_TITLE)
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

      expect(setup.captureCharFrame()).not.toContain(REWIND_TITLE)
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
      await said(setup, '/rewind', REWIND_TITLE)

      setup.mockInput.pressEnter()
      expect(await frameShowing({ setup, text: 'rewind to here' })).toContain('rewind to here')

      setup.mockInput.pressEnter()
      const frame = await frameWhen({
        setup,
        holds: (drawn) => !drawn.includes(REWIND_TITLE),
        describe: 'the rewind overlay to close',
      })
      expect(frame).not.toContain(REWIND_TITLE)
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
      await said(setup, '/compact', 'context compacted')

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

      expect(setup.captureCharFrame()).not.toContain('failed')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('refuses an argument it does not understand, and says so', async () => {
    const setup = await opened(appWith())

    try {
      await said(setup, 'build the parser')
      await said(setup, '/compact sideways', 'not sideways')

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

      const frame = await saidOpening(setup, '/compact', COMPACTING)
      expect(frame).toContain(COMPACTING)
      expect(frame).toContain('esc to interrupt')
      expect(frame).not.toContain('Ask anything')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('takes focus off the composer, so no caret is left drawing over the card', async () => {
    const setup = await opened(slow())

    try {
      await said(setup, 'build the parser')
      await said(setup, 'now the lexer')

      expect(await saidOpening(setup, '/compact', COMPACTING)).toContain(COMPACTING)

      await setup.mockInput.typeText('typed over the card')
      await setup.flush()

      expect(setup.captureCharFrame()).not.toContain('typed over the card')
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

      await saidOpening(setup, '/compact', COMPACTING)

      setup.mockInput.pressEscape()
      await frameWhen({
        setup,
        holds: (drawn) => !drawn.includes(COMPACTING),
        describe: 'the compaction to stop',
      })

      expect(setup.captureCharFrame()).not.toContain(COMPACTING)
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

      const frame = await saidOpening(setup, '/compact', COMPACTING)
      expect(frame).toContain(COMPACTING)
      expect(frame).not.toContain('for -')
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})

