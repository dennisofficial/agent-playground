import type { ScrollBoxRenderable } from '@opentui/core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { relaxScrollbarThumb } from '../scrollbar-thumb'

const WIDTH = 40

const HEIGHT = 24

const LINES = 30

const THUMB = /[█▀▄]/

function thumbRows(frame: string): number {
  return frame.split('\n').filter((row) => THUMB.test(row.slice(WIDTH - 1))).length
}

async function mount(relax: boolean) {
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={HEIGHT}>
      <scrollbox
        flexGrow={1}
        ref={(box: ScrollBoxRenderable | null) => {
          if (box && relax) relaxScrollbarThumb(box)
        }}
      >
        {Array.from({ length: LINES }, (_, line) => (
          <text key={line}>{`line ${line}`}</text>
        ))}
      </scrollbox>
    </box>,
    { width: WIDTH, height: HEIGHT },
  )
  await setup.flush()
  return setup
}

describe('the scrollbar thumb', () => {
  it('fills the track in proportion to how much of the content is on screen', async () => {
    const setup = await mount(true)
    try {
      const rows = thumbRows(setup.captureCharFrame())
      expect(rows).toBeGreaterThanOrEqual(Math.floor((HEIGHT * HEIGHT) / LINES) - 1)
      expect(rows).toBeLessThanOrEqual(HEIGHT)
    } finally {
      setup.renderer.destroy()
    }
  })

  it('is left at half the track by OpenTUI without the fix', async () => {
    const setup = await mount(false)
    try {
      expect(thumbRows(setup.captureCharFrame())).toBeLessThanOrEqual(HEIGHT / 2 + 1)
    } finally {
      setup.renderer.destroy()
    }
  })
})
