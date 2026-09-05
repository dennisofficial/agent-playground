import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React, { act } from 'react'

const WIDTH = 40
const VIEWPORT = 6
const LINE_COUNT = 20

const line = (index: number): string => `line${String(index).padStart(2, '0')} content here`

function Harness(): React.ReactNode {
  return (
    <box flexDirection="column" width={WIDTH} height={VIEWPORT}>
      <scrollbox flexGrow={1} flexShrink={1} flexBasis={0} stickyScroll={false} viewportCulling>
        {Array.from({ length: LINE_COUNT }, (_, index) => (
          <text key={index} id={`entry-${index}`}>
            {line(index)}
          </text>
        ))}
      </scrollbox>
    </box>
  )
}

async function mount() {
  const setup = await testRender(<Harness />, { width: WIDTH, height: VIEWPORT })
  await act(async () => {
    await setup.flush()
  })
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

function highlightKey(setup: Mounted): string | null {
  const frame = setup.captureSpans()
  const span = frame.lines[1]?.spans.find((piece) => piece.text.includes('l'))
  return span ? `${span.bg.r},${span.bg.g},${span.bg.b},${span.bg.a}` : null
}

function highlightedScreenRows(setup: Mounted, key: string): number[] {
  const frame = setup.captureSpans()
  const rows: number[] = []
  frame.lines.forEach((lineFrame, index) => {
    const hit = lineFrame.spans.some(
      (piece) => `${piece.bg.r},${piece.bg.g},${piece.bg.b},${piece.bg.a}` === key,
    )
    if (hit) rows.push(index)
  })
  return rows
}

describe('selection while a scrollbox scrolls', () => {
  it('keeps the selected text after a wheel scroll', async () => {
    const setup = await mount()
    try {
      await drag(setup, [0, 1], [5, 2])
      const before = selectedLines(setup)
      expect(before.length).toBe(2)

      await scroll(setup, 'down', 3)
      expect(selectedLines(setup)).toEqual(before)

      await scroll(setup, 'up', 3)
      expect(selectedLines(setup)).toEqual(before)
    } finally {
      setup.renderer.destroy()
    }
  })

  it('moves the highlight with the content on a small scroll', async () => {
    const setup = await mount()
    try {
      await drag(setup, [0, 1], [5, 2])
      const key = highlightKey(setup)
      expect(key).not.toBeNull()
      expect(highlightedScreenRows(setup, key!)).toEqual([1, 2])

      await scroll(setup, 'down', 1)
      expect(highlightedScreenRows(setup, key!)).toEqual([0, 1])
    } finally {
      setup.renderer.destroy()
    }
  })

  it('drops the anchor row from a backwards drag, matching plain drag semantics', async () => {
    const setup = await mount()
    try {
      await drag(setup, [0, 2], [10, 0])
      expect(selectedLines(setup)).toEqual(['tent here', line(1)])
    } finally {
      setup.renderer.destroy()
    }
  })
})
