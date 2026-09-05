import type { ScrollBoxRenderable } from '@opentui/core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React, { act, useMemo, useRef } from 'react'

import { useEntryWindow } from '../../hooks/use-entry-window'
import { useTranscriptFollow } from '../../hooks/use-transcript-follow'

const WIDTH = 40
const VIEWPORT = 8
const ENTRY_COUNT = 300

const line = (index: number): string => `line${String(index).padStart(3, '0')} content here`

function Entry({ entryKey, text }: { entryKey: string; text: string }): React.ReactNode {
  return (
    <box id={entryKey} flexDirection="column">
      <text>{text}</text>
    </box>
  )
}

function Harness({ culling = true }: { culling?: boolean }): React.ReactNode {
  const entries = useMemo(
    () => Array.from({ length: ENTRY_COUNT }, (_, index) => ({ key: `e${index}`, text: line(index) })),
    [],
  )
  const scroller = useRef<ScrollBoxRenderable | null>(null)
  const windowing = useEntryWindow({ entries, scroller, anchorIndex: -1, width: WIDTH })
  const follow = useTranscriptFollow({
    scroller,
    onTick: windowing.handleTick,
    offsetOfKey: windowing.offsetOfKey,
  })

  if (process.env.DEBUG_PIN === '1') {
    console.error(
      `render sections: ${windowing.sections
        .map((section) =>
          section.kind === 'spacer'
            ? `spacer(${section.height})`
            : `entries(${section.span.start}..${section.span.end})`,
        )
        .join(' ')}`,
    )
  }

  const mounted: React.ReactNode[] = []
  windowing.sections.forEach((section, sectionIndex) => {
    if (section.kind === 'spacer') {
      mounted.push(<box key={`spacer:${sectionIndex}`} height={section.height} flexShrink={0} />)
      return
    }
    for (const entry of entries.slice(section.span.start, section.span.end)) {
      mounted.push(<Entry key={entry.key} entryKey={entry.key} text={entry.text} />)
    }
  })

  return (
    <box flexDirection="column" width={WIDTH} height={VIEWPORT}>
      <scrollbox
        ref={follow.scroller}
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        stickyScroll
        stickyStart="bottom"
        viewportCulling={culling}
      >
        {mounted}
      </scrollbox>
    </box>
  )
}

async function settle(setup: Awaited<ReturnType<typeof testRender>>): Promise<void> {
  for (let pass = 0; pass < 10; pass += 1) {
    await act(async () => {
      await setup.flush()
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  }
}

async function mount(culling = true) {
  const setup = await testRender(<Harness culling={culling} />, { width: WIDTH, height: VIEWPORT })
  await settle(setup)
  return setup
}

type Mounted = Awaited<ReturnType<typeof mount>>

async function drag(setup: Mounted, from: [number, number], to: [number, number]): Promise<void> {
  await act(async () => {
    await setup.mockMouse.drag(from[0], from[1], to[0], to[1])
    await setup.flush()
  })
}

async function scroll(setup: Mounted, direction: 'up' | 'down', times = 1): Promise<void> {
  await act(async () => {
    for (let index = 0; index < times; index += 1) {
      await setup.mockMouse.scroll(WIDTH / 2, VIEWPORT / 2, direction)
    }
    await setup.flush()
  })
}

function selectedLines(setup: Mounted): string[] {
  const selection = setup.renderer.getSelection()
  if (selection === null) return []
  return selection.selectedRenderables
    .filter((renderable) => !renderable.isDestroyed)
    .map((renderable) => renderable.getSelectedText())
    .filter((text) => text.length > 0)
}

describe('selection in a windowed transcript', () => {
  it('keeps the selected entries mounted when the window scrolls past them', async () => {
    const setup = await mount()
    try {
      await drag(setup, [0, 6], [10, 7])
      const before = selectedLines(setup)
      expect(before).toEqual([line(298), 'line299 con'])

      await scroll(setup, 'up', 200)
      expect(selectedLines(setup)).toEqual(before)

      await scroll(setup, 'down', 200)
      expect(selectedLines(setup)).toEqual(before)
    } finally {
      setup.renderer.destroy()
    }
  })

  it('extends a drag across window moves without losing the anchor entry', async () => {
    const setup = await mount(false)
    try {
      await scroll(setup, 'up', 100)
      await settle(setup)
      const topLine = setup.captureCharFrame().split('\n')[0]?.trim() ?? ''

      await act(async () => {
        await setup.mockMouse.pressDown(0, 0)
        for (let round = 0; round < 20; round += 1) {
          for (let step = 0; step < 5; step += 1) {
            await setup.mockMouse.scroll(WIDTH / 2, VIEWPORT / 2, 'down')
          }
          await setup.renderOnce()
          await setup.mockMouse.moveTo(10 + (round % 2), 6)
        }
        await setup.mockMouse.release(10, 6)
      })
      await act(async () => {
        await setup.flush()
      })

      const selected = selectedLines(setup)
      expect(selected[0]).toBe(topLine)
      expect(selected.length).toBeGreaterThan(VIEWPORT)
    } finally {
      setup.renderer.destroy()
    }
  })
})
