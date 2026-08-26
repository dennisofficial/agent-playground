import type { ScrollBoxRenderable } from '@opentui/core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { hideVerticalScrollbar } from '../hide-scrollbar'

const WIDTH = 40

const HEIGHT = 24

const LINES = 30

const THUMB = /[█▀▄]/

function thumbRows(frame: string): number {
  return frame.split('\n').filter((row) => THUMB.test(row.slice(WIDTH - 1))).length
}

async function mount(hide: boolean) {
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={HEIGHT}>
      <scrollbox
        flexGrow={1}
        ref={(box: ScrollBoxRenderable | null) => {
          if (box && hide) hideVerticalScrollbar(box)
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

describe('a hidden scrollbar', () => {
  it('leaves no track beside content that overflows', async () => {
    const setup = await mount(true)
    try {
      expect(thumbRows(setup.captureCharFrame())).toBe(0)
    } finally {
      setup.renderer.destroy()
    }
  })

  it('is what OpenTUI would otherwise draw', async () => {
    const setup = await mount(false)
    try {
      expect(thumbRows(setup.captureCharFrame())).toBeGreaterThan(0)
    } finally {
      setup.renderer.destroy()
    }
  })
})
