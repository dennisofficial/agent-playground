import { parseColor, type ScrollBoxRenderable } from '@opentui/core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React, { act } from 'react'

import {
  PANEL_BOTTOM_EDGE,
  PANEL_TOP_EDGE,
  RAIL,
  RAIL_HEAD,
  RAIL_TAIL,
} from '../../borders'
import { PANEL_INSET } from '../../components/panel'
import {
  applyBlockDensity,
  EBlockDensity,
  SHIPPED_DENSITY,
} from '../../density-store'
import {
  applyFenceWrap,
  EFenceWrap,
  SHIPPED_FENCE_WRAP,
} from '../../fence-wrap-store'
import { theme } from '../../theme'
import { CONTENT_PADDING, gutterWidth } from '../fenced-block'
import { MarkdownView } from '../markdown-view'
import { grammarsReady, teardown } from './harness'

await grammarsReady()

const WIDTH = 60
const HEIGHT = 20

const WIDE_CODE = [`const wide = ${"'x'".repeat(40)};`, 'const last = 2;'].join('\n')

const WIDE_FENCE = ['```ts', WIDE_CODE, '```'].join('\n')

const CODE_INSET = CONTENT_PADDING + gutterWidth(WIDE_CODE)

const FILLER = Array.from({ length: 25 }, (_, i) => `filler line ${i}`).join('\n\n')

const WIDE_MD = `${'alpha '.repeat(20)}omega`

const WIDE_MD_FENCE = ['```md', WIDE_MD, '```'].join('\n')

function rowOf(frame: string, needle: string): number {
  return frame.split('\n').findIndex((line) => line.includes(needle))
}

function codeOf(line: string | undefined): string {
  if (!line) return ''
  const rail = line.indexOf(RAIL)
  return rail < 0 ? line : line.slice(rail + 1 + CODE_INSET)
}

async function mount(source: string) {
  let outer: ScrollBoxRenderable | null = null
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={HEIGHT}>
      <scrollbox
        flexGrow={1}
        stickyScroll
        stickyStart="bottom"
        ref={(r: ScrollBoxRenderable | null) => {
          outer = r
        }}
      >
        <box flexDirection="column">
          <MarkdownView source={source} width={WIDTH - 4} />
        </box>
      </scrollbox>
    </box>,
    { width: WIDTH, height: HEIGHT },
  )
  await setup.flush()
  return { setup, outer: () => outer as ScrollBoxRenderable | null }
}

async function hover(args: {
  setup: Awaited<ReturnType<typeof mount>>['setup']
  x: number
  y: number
}): Promise<void> {
  const { setup, x, y } = args
  await act(async () => {
    await setup.mockMouse.moveTo(x, y)
    await setup.flush()
  })
  await setup.flush()
}

describe('FencedBlock', () => {
  it('keeps a wide fence at its natural width instead of wrapping it', async () => {
    const { setup } = await mount(`${FILLER}\n\n${WIDE_FENCE}`)
    try {
      const frame = setup.captureCharFrame()
      expect(rowOf(frame, 'const last = 2;') - rowOf(frame, 'const wide =')).toBe(1)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('pans the fence sideways on a horizontal wheel, without moving the transcript', async () => {
    const { setup, outer } = await mount(`${FILLER}\n\n${WIDE_FENCE}`)
    try {
      const before = setup.captureCharFrame()
      const codeRow = rowOf(before, 'const wide =')
      const scrollTop = outer()?.scrollTop

      await setup.mockMouse.scroll(10, codeRow, 'right')
      await setup.flush()

      const after = setup.captureCharFrame()
      expect(after.split('\n')[codeRow]).not.toBe(before.split('\n')[codeRow])
      expect(outer()?.scrollTop).toBe(scrollTop)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('pans one column per report on alt+wheel, the spelling every terminal delivers', async () => {
    const { setup, outer } = await mount(`${FILLER}\n\n${WIDE_FENCE}`)
    try {
      const codeRow = rowOf(setup.captureCharFrame(), 'const wide =')
      const before = setup.captureCharFrame().split('\n')[codeRow] ?? ''
      const scrollTop = outer()?.scrollTop

      // Zed reports no horizontal wheel and drops shift+scroll, so alt is the only spelling that
      // survives there.
      await setup.mockMouse.scroll(10, codeRow, 'up', { modifiers: { alt: true } })
      await setup.flush()

      const after = setup.captureCharFrame().split('\n')[codeRow] ?? ''
      expect(codeOf(after).slice(0, 19)).toBe(codeOf(before).slice(1, 20))
      expect(outer()?.scrollTop).toBe(scrollTop)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('pans when its scrollbar is dragged', async () => {
    const { setup, outer } = await mount(`${FILLER}\n\n${WIDE_FENCE}`)
    try {
      const lines = setup.captureCharFrame().split('\n')
      const codeRow = rowOf(setup.captureCharFrame(), 'const wide =')
      const barRow = lines.findIndex((line, i) => i > codeRow && line.includes('━'))
      const before = lines[codeRow]
      const scrollTop = outer()?.scrollTop

      await setup.mockMouse.drag((lines[barRow]?.indexOf('━') ?? 0) + 1, barRow, 30, barRow)
      await setup.flush()

      expect(setup.captureCharFrame().split('\n')[codeRow]).not.toBe(before)
      expect(outer()?.scrollTop).toBe(scrollTop)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('pans one column per report, so a swipe scrolls rather than jumps', async () => {
    const { setup } = await mount(`${FILLER}\n\n${WIDE_FENCE}`)
    try {
      const codeRow = rowOf(setup.captureCharFrame(), 'const wide =')
      const textAt = (frame: string): string => codeOf(frame.split('\n')[codeRow])
      const start = textAt(setup.captureCharFrame())

      await setup.mockMouse.scroll(10, codeRow, 'right')
      await setup.flush()

      expect(textAt(setup.captureCharFrame()).slice(0, 20)).toBe(start.slice(1, 21))
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('pans once, not twice, when shift rides along on a sideways report', async () => {
    const { setup } = await mount(`${FILLER}\n\n${WIDE_FENCE}`)
    try {
      const codeRow = rowOf(setup.captureCharFrame(), 'const wide =')
      const before = setup.captureCharFrame().split('\n')[codeRow] ?? ''

      // macOS turns shift+scroll into a horizontal scroll before the terminal sees it, so on a
      // trackpad both spellings arrive as one left/right report with shift set.
      await setup.mockMouse.scroll(10, codeRow, 'right', { modifiers: { shift: true } })
      await setup.flush()

      const after = setup.captureCharFrame().split('\n')[codeRow] ?? ''
      expect(codeOf(after).slice(0, 19)).toBe(codeOf(before).slice(1, 20))
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('scrolls the transcript on a plain vertical wheel over a fence', async () => {
    const { setup, outer } = await mount(`${FILLER}\n\n${WIDE_FENCE}`)
    try {
      const codeRow = rowOf(setup.captureCharFrame(), 'const wide =')
      const scrollTop = outer()?.scrollTop ?? 0

      await setup.mockMouse.scroll(10, codeRow, 'up')
      await setup.flush()

      expect(outer()?.scrollTop).toBeLessThan(scrollTop)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('holds the transcript still for the vertical component of a sideways swipe', async () => {
    const { setup, outer } = await mount(`${FILLER}\n\n${WIDE_FENCE}`)
    try {
      const codeRow = rowOf(setup.captureCharFrame(), 'const wide =')

      await setup.mockMouse.scroll(10, codeRow, 'right')
      await setup.flush()
      const scrollTop = outer()?.scrollTop ?? 0

      await setup.mockMouse.scroll(10, codeRow, 'up')
      await setup.flush()

      expect(outer()?.scrollTop).toBe(scrollTop)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('shrinks a short fence to its content instead of the viewport', async () => {
    const { setup } = await mount(['```ts', 'const x = 1;', '```'].join('\n'))
    try {
      const top = rowOf(setup.captureCharFrame(), ' ts')
      await hover({ setup, x: 1, y: top })

      const lines = setup.captureCharFrame().split('\n')
      const bottom = lines.find((line) => line.includes(RAIL_TAIL))?.replace(/\s+$/, '') ?? ''
      expect(bottom.length).toBeLessThan(WIDTH / 2)
      expect(lines[top]).toContain(' ts')
      expect(lines[top]).toContain('copy')
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('never shrinks below the header, which would cost it the copy button', async () => {
    const { setup } = await mount(['```ts', 'x', '```'].join('\n'))
    try {
      const row = rowOf(setup.captureCharFrame(), ' ts')
      await hover({ setup, x: 1, y: row })

      const top = setup.captureCharFrame().split('\n')[row] ?? ''
      expect(top).toContain(' ts')
      expect(top).toContain('copy')
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('leaves the transcript scrolling normally over prose', async () => {
    const { setup, outer } = await mount(`${FILLER}\n\n${WIDE_FENCE}`)
    try {
      const proseRow = rowOf(setup.captureCharFrame(), 'filler line')
      const scrollTop = outer()?.scrollTop ?? 0

      await setup.mockMouse.scroll(10, proseRow >= 0 ? proseRow : 1, 'up')
      await setup.flush()

      expect(outer()?.scrollTop).toBeLessThan(scrollTop)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('opens on a half cell, bands the header, then seams into the code', async () => {
    const { setup } = await mount(['```ts', 'const x = 1;', '```'].join('\n'))
    try {
      const rows = setup.captureCharFrame().split('\n')
      const spans = setup.captureSpans()
      const cellAt = (row: number) => {
        let column = 0
        for (const span of spans.lines[row]?.spans ?? []) {
          for (const _char of span.text) {
            if (column === PANEL_INSET) return span
            column += 1
          }
        }
        return undefined
      }
      const band = parseColor(theme.panelBand)
      const fill = parseColor(theme.panelBg)

      const header = rowOf(setup.captureCharFrame(), ' ts')
      const code = rows.findIndex((line) => line.includes('const x = 1;'))
      const tail = rows.findIndex((line) => line.startsWith(RAIL_TAIL))

      expect(rows[header - 1]?.startsWith(RAIL_HEAD)).toBe(true)
      expect(rows[header - 1]?.[PANEL_INSET]).toBe(PANEL_TOP_EDGE)
      expect(cellAt(header - 1)?.fg.equals(band)).toBe(true)

      expect(cellAt(header)?.bg.equals(band)).toBe(true)

      expect(code - header).toBe(2)
      expect(rows[header + 1]?.startsWith(RAIL)).toBe(true)
      expect(rows[header + 1]?.[PANEL_INSET]).toBe(PANEL_BOTTOM_EDGE)
      expect(cellAt(header + 1)?.fg.equals(band)).toBe(true)
      expect(cellAt(header + 1)?.bg.equals(fill)).toBe(true)

      expect(cellAt(code)?.bg.equals(fill)).toBe(true)
      expect(cellAt(tail)?.fg.equals(fill)).toBe(true)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('drops both caps and the seam when blocks are set compact', async () => {
    applyBlockDensity(EBlockDensity.Compact)
    try {
      const { setup } = await mount(['```ts', 'const x = 1;', '```'].join('\n'))
      try {
        const rows = setup.captureCharFrame().split('\n')
        const header = rowOf(setup.captureCharFrame(), ' ts')
        const code = rows.findIndex((line) => line.includes('const x = 1;'))

        expect(code - header).toBe(1)
        expect(rows[header - 1]?.includes(PANEL_TOP_EDGE) ?? false).toBe(false)
        expect(rows.some((line) => line.startsWith(RAIL_TAIL))).toBe(false)
        expect(rows.some((line) => line.includes(PANEL_BOTTOM_EDGE))).toBe(false)
      } finally {
        await teardown(setup)
      }
    } finally {
      applyBlockDensity(SHIPPED_DENSITY)
    }
  }, 30_000)

  it('spends no band on a fence with nothing to name, and sets copy into its cap', async () => {
    const { setup } = await mount('```\nplain text\n```')
    try {
      const rows = setup.captureCharFrame().split('\n')
      const code = rows.findIndex((line) => line.includes('plain text'))

      expect(rows[code - 1]?.startsWith(RAIL_HEAD)).toBe(true)
      expect(rows[code - 1]?.includes(PANEL_TOP_EDGE)).toBe(true)
      expect(rows[code + 1]?.startsWith(RAIL_TAIL)).toBe(true)
      expect(rows[code - 1]).not.toContain('copy')

      await hover({ setup, x: 4, y: code })

      const hovered = setup.captureCharFrame().split('\n')
      expect(hovered[code - 1]).toContain('copy')
      expect(hovered[code]).toContain('plain text')
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('wraps a wide md fence to the panel instead of panning it', async () => {
    const { setup } = await mount(`${FILLER}\n\n${WIDE_MD_FENCE}`)
    try {
      const frame = setup.captureCharFrame()
      expect(rowOf(frame, 'omega')).toBeGreaterThan(rowOf(frame, 'alpha'))
      expect(frame).not.toContain('⇄')
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('numbers no rows on a wrapped fence, since a wrapped line is not a source line', async () => {
    const { setup } = await mount(`${FILLER}\n\n${WIDE_MD_FENCE}`)
    try {
      const line = setup.captureCharFrame().split('\n')[rowOf(setup.captureCharFrame(), 'alpha')]
      const rail = line?.indexOf(RAIL) ?? -1
      expect(line?.slice(rail + 1 + CONTENT_PADDING).startsWith('alpha')).toBe(true)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('pans even an md fence sideways when wrapping is set to never', async () => {
    applyFenceWrap(EFenceWrap.Never)
    try {
      const { setup } = await mount(`${FILLER}\n\n${WIDE_MD_FENCE}`)
      try {
        const frame = setup.captureCharFrame()
        expect(frame).toContain('⇄')
      } finally {
        await teardown(setup)
      }
    } finally {
      applyFenceWrap(SHIPPED_FENCE_WRAP)
    }
  }, 30_000)

  it('falls back to plain text for an unlabelled fence, and labels its header with nothing', async () => {
    const { setup } = await mount('```\nno language here\n```')
    try {
      const lines = setup.captureCharFrame().split('\n')
      expect(lines.some((line) => line.includes('no language here'))).toBe(true)
      expect(lines.some((line) => line.includes(' ts'))).toBe(false)
    } finally {
      await teardown(setup)
    }
  }, 30_000)
})
