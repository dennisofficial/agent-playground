import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React, { act, useSyncExternalStore } from 'react'

import { WINDOW_CAP } from '../entry-window'

const { deriveTranscript, createConversationStore } = await import('../../store')
const { createDeltaChannel } = await import('@dltech/atlas-harness')
const { fixtureThreadId } = await import('../../store/__tests__/fixture')
const { clocked, said } = await import('../../store/__tests__/tool-fixture')
const { Transcript } = await import('../components/transcript')
const { grammarsReady, teardown } = await import('../markdown/__tests__/harness')
const { frameSettled, frameWhen } = await import('./waiting')

await grammarsReady()

const AT = '2026-08-26T12:00:00.000Z'
const WIDTH = 80
const HEIGHT = 30
const CWD = '/Users/dennis/Developer/atlas'
const NOW = 95_000

const ENTRY_COUNT = 1_200
const FIRST_MESSAGE = 'message 0001'
const LAST_MESSAGE = `message ${ENTRY_COUNT}`

const BIG = deriveTranscript({
  events: clocked(
    Array.from({ length: ENTRY_COUNT }, (_, i) => ({
      draft: said(`message ${String(i + 1).padStart(4, '0')}`),
      at: AT,
    })),
  ),
  signals: [],
})

type ScrollerLike = {
  scrollTop: number
  scrollHeight: number
  viewport: { height: number }
  content: { getChildren: () => readonly { id: string }[] }
  scrollTo: (offset: number) => void
  getChildren: () => readonly unknown[]
}

const isScroller = (node: unknown): node is ScrollerLike =>
  typeof node === 'object' &&
  node !== null &&
  'scrollTo' in node &&
  'content' in node &&
  'scrollHeight' in node

function findScroller(node: unknown): ScrollerLike {
  if (isScroller(node)) return node
  const children = (node as { getChildren?: () => readonly unknown[] }).getChildren?.() ?? []
  for (const child of children) {
    try {
      return findScroller(child)
    } catch {
      // not under this branch
    }
  }
  throw new Error('the transcript scrollbox never mounted')
}

const mountedCount = (scroller: ScrollerLike): number => {
  const keys = new Set(BIG.entries.map((entry) => entry.key))
  return scroller.content.getChildren().filter((child) => keys.has(child.id)).length
}

const mounted = () =>
  testRender(
    <box flexDirection="column" width={WIDTH} height={HEIGHT}>
      <Transcript model={BIG} width={WIDTH} now={NOW} cwd={CWD} />
    </box>,
    { width: WIDTH, height: HEIGHT },
  )

describe('a transcript past the windowing threshold', () => {
  it('opens on the tail mounting only a window of entries', async () => {
    const setup = await mounted()
    try {
      const frame = await frameSettled({ setup })
      expect(frame).toContain(LAST_MESSAGE)

      const scroller = findScroller(setup.renderer.root)
      expect(mountedCount(scroller)).toBeLessThanOrEqual(WINDOW_CAP)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('mounts the head when scrolled to the top, and the tail again when scrolled back', async () => {
    const setup = await mounted()
    try {
      await frameSettled({ setup })
      const scroller = findScroller(setup.renderer.root)

      await act(async () => {
        scroller.scrollTo(0)
        await setup.flush()
      })
      const top = await frameWhen({
        setup,
        holds: (frame) => frame.includes(FIRST_MESSAGE),
        describe: 'the first message after scrolling to the top',
      })
      expect(top).toContain(FIRST_MESSAGE)
      expect(mountedCount(scroller)).toBeLessThanOrEqual(WINDOW_CAP)

      await act(async () => {
        scroller.scrollTo(Math.max(0, scroller.scrollHeight - scroller.viewport.height))
        await setup.flush()
      })
      const bottom = await frameWhen({
        setup,
        holds: (frame) => frame.includes(LAST_MESSAGE),
        describe: 'the last message after scrolling back to the bottom',
      })
      expect(bottom).toContain(LAST_MESSAGE)
      expect(mountedCount(scroller)).toBeLessThanOrEqual(WINDOW_CAP)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('keeps the scroll extent close to the true height once measured', async () => {
    const setup = await mounted()
    try {
      await frameSettled({ setup })
      const scroller = findScroller(setup.renderer.root)

      const before = scroller.scrollHeight
      await act(async () => {
        scroller.scrollTo(0)
        await setup.flush()
      })
      await frameWhen({
        setup,
        holds: (frame) => frame.includes(FIRST_MESSAGE),
        describe: 'the first message',
      })
      await act(async () => {
        scroller.scrollTo(Math.max(0, scroller.scrollHeight - scroller.viewport.height))
        await setup.flush()
      })
      await frameWhen({
        setup,
        holds: (frame) => frame.includes(LAST_MESSAGE),
        describe: 'the last message',
      })

      expect(Math.abs(scroller.scrollHeight - before)).toBeLessThanOrEqual(before * 0.05)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('keeps the tail mounted as a chunk streams in', async () => {
    const channel = createDeltaChannel()
    const store = createConversationStore({
      channel,
      threadId: fixtureThreadId,
      events: clocked(
        Array.from({ length: 400 }, (_, i) => ({
          draft: said(`seed ${String(i + 1).padStart(4, '0')}`),
          at: AT,
        })),
      ),
    })

    function StoreDrivenTranscript(): React.ReactNode {
      const model = useSyncExternalStore(store.subscribe, store.getSnapshot)
      return <Transcript model={model} width={WIDTH} now={NOW} cwd={CWD} />
    }

    const setup = await testRender(
      <box flexDirection="column" width={WIDTH} height={HEIGHT}>
        <StoreDrivenTranscript />
      </box>,
      { width: WIDTH, height: HEIGHT },
    )
    try {
      await frameSettled({ setup })

      const publisher = channel.publisherFor({ threadId: fixtureThreadId })
      await act(async () => {
        publisher.onChunk({ type: 'text-delta', id: 'b1', text: 'fresh off the wire' })
        await setup.flush()
      })

      const frame = await frameWhen({
        setup,
        holds: (captured) => captured.includes('fresh off the wire'),
        describe: 'the streamed chunk at the tail',
      })
      expect(frame).toContain('fresh off the wire')

      const keys = new Set(store.getSnapshot().entries.map((entry) => entry.key))
      const mountedNow = findScroller(setup.renderer.root)
        .content.getChildren()
        .filter((child) => keys.has(child.id)).length
      expect(mountedNow).toBeLessThanOrEqual(WINDOW_CAP)
    } finally {
      store.dispose()
      await teardown(setup)
    }
  }, 60_000)
})
