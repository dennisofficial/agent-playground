import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseColor } from '@opentui/core'

import { toThreadId } from '@dltech/atlas-core'
import { testRender } from '@opentui/react/test-utils'
import { beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'

import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { theme } from '../../ui/theme'
import { App } from '../app'
import { fakeApp, scriptedModelPort, type FakeApp } from './fake-app'

await grammarsReady()

const THREAD = toThreadId('opened-thread')

const WIDE = { width: 150, height: 40 }

const READ_MS = 60

type Mounted = Awaited<ReturnType<typeof testRender>>

let root: string

const write = ({ at, content }: { at: string; content: string }): void => {
  const path = join(root, at)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

const appWith = (): FakeApp =>
  fakeApp({
    model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }),
    workspaceRoot: root,
  })

async function opened(app: FakeApp): Promise<Mounted> {
  const setup = await testRender(
    <App app={app} opened={{ threadId: THREAD, events: [], turns: [], name: null }} />,
    WIDE,
  )
  await setup.flush()
  await settle(250)
  await setup.flush()
  return setup
}

async function landed(setup: Mounted): Promise<void> {
  await settle(READ_MS)
  await setup.flush()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atlas-mention-app-'))
})

type Colour = { equals: (other: unknown) => boolean }

type CapturedSpan = { text: string; fg: Colour }

type CapturedSpans = { lines: ({ spans: CapturedSpan[] } | undefined)[] }

const paintedLink = ({ setup, text }: { setup: Mounted; text: string }): boolean => {
  const spans = setup.captureSpans() as CapturedSpans
  const link = parseColor(theme.link)

  return spans.lines.some((line) =>
    (line?.spans ?? []).some((span) => span.text.includes(text) && span.fg.equals(link)),
  )
}

describe('a mention in the draft', () => {
  it('is painted once it names a file the workspace has', async () => {
    write({ at: 'src/mentionable.ts', content: 'export const one = 1\n' })
    const setup = await opened(appWith())

    try {
      await setup.mockInput.typeText('why is @src/mentionable.ts broken')
      await landed(setup)

      expect(paintedLink({ setup, text: '@src/mentionable.ts' })).toBe(true)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('is left alone while it still names nothing', async () => {
    write({ at: 'src/mentionable.ts', content: 'export const one = 1\n' })
    const setup = await opened(appWith())

    try {
      await setup.mockInput.typeText('why is @src/mention broken')
      await landed(setup)

      expect(paintedLink({ setup, text: '@src/mention' })).toBe(false)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('stops at the mention, however much is typed after it', async () => {
    write({ at: 'src/mentionable.ts', content: 'export const one = 1\n' })
    const setup = await opened(appWith())

    try {
      await setup.mockInput.typeText('@src/mentionable.ts')
      await landed(setup)

      await setup.mockInput.typeText(' thats weird?')
      await landed(setup)

      expect(paintedLink({ setup, text: '@src/mentionable.ts' })).toBe(true)
      expect(paintedLink({ setup, text: 'thats weird?' })).toBe(false)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('goes with the draft when the message is sent', async () => {
    write({ at: 'src/mentionable.ts', content: 'export const one = 1\n' })
    const setup = await opened(appWith())

    try {
      await setup.mockInput.typeText('why is @src/mentionable.ts broken')
      await landed(setup)

      setup.mockInput.pressEnter()
      await settle(2_000)
      await setup.flush()

      expect(paintedLink({ setup, text: '@src/mentionable.ts' })).toBe(false)
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})

describe('mentioning a file from the composer', () => {
  it('opens on the first level of the workspace', async () => {
    write({ at: 'src/mentionable.ts', content: 'export const one = 1\n' })
    write({ at: 'README.md', content: '# hi\n' })
    const setup = await opened(appWith())

    try {
      await setup.mockInput.typeText('read @')
      await landed(setup)

      const frame = setup.captureCharFrame()
      expect(frame).toContain('Files')
      expect(frame).toContain('src/')
      expect(frame).toContain('README.md')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('lists what is under a directory once it is stepped into', async () => {
    write({ at: 'src/mentionable.ts', content: 'export const one = 1\n' })
    write({ at: 'src/other.ts', content: 'export const two = 2\n' })
    const setup = await opened(appWith())

    try {
      await setup.mockInput.typeText('read @src/')
      await landed(setup)

      const frame = setup.captureCharFrame()
      expect(frame).toContain('src/mentionable.ts')
      expect(frame).toContain('src/other.ts')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('walks into a directory on tab and keeps the menu open', async () => {
    write({ at: 'src/mentionable.ts', content: 'export const one = 1\n' })
    const setup = await opened(appWith())

    try {
      await setup.mockInput.typeText('read @sr')
      await landed(setup)

      await setup.mockInput.pressTab()
      await landed(setup)

      const frame = setup.captureCharFrame()
      expect(frame).toContain('read @src/')
      expect(frame).toContain('src/mentionable.ts')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('settles on a file on tab, so the sentence can go on', async () => {
    write({ at: 'src/mentionable.ts', content: 'export const one = 1\n' })
    const setup = await opened(appWith())

    try {
      await setup.mockInput.typeText('read @src/ment')
      await landed(setup)

      await setup.mockInput.pressTab()
      await landed(setup)

      expect(setup.captureCharFrame()).toContain('read @src/mentionable.ts')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('browses a directory outside the workspace entirely', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'atlas-elsewhere-'))
    mkdirSync(join(elsewhere, 'cubix-infra'), { recursive: true })
    const setup = await opened(appWith())

    try {
      await setup.mockInput.typeText(`look at @${elsewhere}/`)
      await landed(setup)

      expect(setup.captureCharFrame()).toContain('cubix-infra/')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('says which file it attached, beneath what was typed', async () => {
    write({ at: 'src/mentionable.ts', content: 'export const one = 1\n' })
    const setup = await opened(appWith())

    try {
      await setup.mockInput.typeText('why is @src/mentionable.ts broken')
      await landed(setup)

      setup.mockInput.pressEnter()
      await settle(2_000)
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).toContain('⎿ file src/mentionable.ts')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('sends a mention of a file that is not there as ordinary prose', async () => {
    const setup = await opened(appWith())

    try {
      await setup.mockInput.typeText('why is @src/absent.ts broken')
      await landed(setup)

      setup.mockInput.pressEnter()
      await settle(2_000)
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).toContain('why is @src/absent.ts broken')
      expect(frame).not.toContain('⎿ file')
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})
