import { parseColor, type CapturedFrame, type RGBA } from '@opentui/core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { PANEL_BOTTOM_EDGE, PANEL_TOP_EDGE } from '../borders'
import { Panel } from '../components/panel'
import { teardown } from '../markdown/__tests__/harness'
import { theme } from '../theme'

const WIDTH = 60

const mount = async (node: React.ReactNode) => {
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={20}>
      {node}
    </box>,
    { width: WIDTH, height: 20 },
  )
  await setup.flush()
  return setup
}

/** The body-to-band seam also draws `▀`, so the closing cap is found from the bottom up. */
const edgeColour = (frame: CapturedFrame, edge: string, fromEnd = false): RGBA | undefined => {
  const lines = fromEnd ? [...frame.lines].reverse() : frame.lines
  for (const line of lines) {
    const span = line.spans.find((candidate) => candidate.text.includes(edge))
    if (span !== undefined) return span.fg
  }
  return undefined
}

describe('panel caps follow the ground they cap', () => {
  it('caps a plain slab in the fill colour at both ends', async () => {
    const setup = await mount(
      <Panel rail={theme.court.yours} fill={theme.userBg}>
        <text fg={theme.userFg}>hello</text>
      </Panel>,
    )
    try {
      const frame = setup.captureSpans()
      expect(edgeColour(frame, PANEL_TOP_EDGE)?.equals(parseColor(theme.userBg))).toBe(true)
      expect(edgeColour(frame, PANEL_BOTTOM_EDGE)?.equals(parseColor(theme.userBg))).toBe(true)
    } finally {
      await teardown(setup)
    }
  })

  it('keeps the top cap in the fill colour when only a footer rides the band', async () => {
    const setup = await mount(
      <Panel
        rail={theme.court.yours}
        fill={theme.userBg}
        band={theme.userBand}
        footer={<text fg={theme.meta}>chips</text>}
      >
        <text fg={theme.userFg}>hello</text>
      </Panel>,
    )
    try {
      const frame = setup.captureSpans()
      expect(edgeColour(frame, PANEL_TOP_EDGE)?.equals(parseColor(theme.userBg))).toBe(true)
      expect(edgeColour(frame, PANEL_BOTTOM_EDGE, true)?.equals(parseColor(theme.userBand))).toBe(true)
    } finally {
      await teardown(setup)
    }
  })

  it('caps a headed panel in the band colour, since the band is what it caps', async () => {
    const setup = await mount(
      <Panel
        rail={theme.court.yours}
        fill={theme.userBg}
        band={theme.userBand}
        header={<text fg={theme.meta}>title</text>}
      >
        <text fg={theme.userFg}>hello</text>
      </Panel>,
    )
    try {
      const frame = setup.captureSpans()
      expect(edgeColour(frame, PANEL_TOP_EDGE)?.equals(parseColor(theme.userBand))).toBe(true)
    } finally {
      await teardown(setup)
    }
  })
})
