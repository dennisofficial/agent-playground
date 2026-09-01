import { describe, expect, it } from 'bun:test'
import { parseColor } from '@opentui/core'
import { testRender } from '@opentui/react/test-utils'
import { act } from 'react'
import React from 'react'

import { EEffort } from '@dltech/atlas-core'

import { Footer } from '../components/footer'
import { EFooterItemReach, type FooterItem } from '../footer-item'
import { cellsOf } from '../hint-layout'
import { teardown } from '../markdown/__tests__/harness'
import { theme } from '../theme'
import { drawn, frameOf, HEIGHT } from './transcript-fixture'

const MODEL = 'haiku-4-5'

const pill = (over: Partial<FooterItem> & { id: string }): FooterItem => ({
  spans: [{ text: over.id }],
  reach: EFooterItemReach.Keyboard,
  onActivate: () => undefined,
  ...over,
})

const PR = pill({
  id: 'pr',
  spans: [
    { text: 'PR #123', fg: theme.hover },
    { text: ' ✓', fg: theme.ok },
  ],
})

const SHELLS = pill({ id: 'shells', spans: [{ text: '⏺ 2/3' }] })

const footer = (props: {
  width: number
  items: readonly FooterItem[]
  strip?: { itemId: string } | null
  onActivateItem?: (item: FooterItem) => void
}): React.ReactNode => (
  <Footer
    width={props.width}
    model={MODEL}
    effort={EEffort.Medium}
    items={props.items}
    strip={props.strip ?? null}
    context={{ percent: 62, tokensUsed: 124_000 }}
    {...(props.onActivateItem === undefined ? {} : { onActivateItem: props.onActivateItem })}
  />
)

const rowOf = (frame: string): string =>
  frame
    .split('\n')
    .map((row) => row.trimEnd())
    .find((row) => row.trim().length > 0) ?? ''

type Colour = { equals: (other: unknown) => boolean }

type Painted = { text: string; fg: Colour; bg: Colour }

type Spans = { lines: ({ spans: Painted[] } | undefined)[] }

const paintedAt = (spans: Spans, row: number, cell: number): Painted | undefined => {
  let column = 0
  for (const span of spans.lines[row]?.spans ?? []) {
    const width = [...span.text].length
    if (cell < column + width) return span
    column += width
  }
  return undefined
}

const groundAt = (spans: Spans, row: number, cell: number): Colour | undefined =>
  paintedAt(spans, row, cell)?.bg

const inkAt = (spans: Spans, row: number, cell: number): Colour | undefined =>
  paintedAt(spans, row, cell)?.fg

const mount = async (
  node: React.ReactNode,
  width: number,
): Promise<Awaited<ReturnType<typeof testRender>>> =>
  testRender(
    <box flexDirection="column" width={width} height={HEIGHT}>
      {node}
    </box>,
    { width, height: HEIGHT },
  )

describe('the pills under the composer', () => {
  it('spells each one after the model and the effort, separated the way the row is', async () => {
    const frame = await frameOf(footer({ width: 140, items: [PR, SHELLS] }), 140)
    expect(rowOf(frame).trimStart()).toStartWith(`${MODEL} · med · PR #123 ✓ · ⏺ 2/3`)
  })

  it('leaves the read-out flush against the far edge', async () => {
    const frame = await frameOf(footer({ width: 140, items: [PR, SHELLS] }), 140)
    const row = rowOf(frame)
    expect(row).toEndWith('124.0k ctx · 62%')
    expect(cellsOf(row)).toBe(140 - 3)
  })

  it('says nothing at a width the ladder sheds them at', async () => {
    const frame = await frameOf(footer({ width: 44, items: [PR, SHELLS] }), 44)
    expect(frame).not.toContain('PR #123')
    expect(frame).not.toContain('2/3')
  })

  it('inverts the selected pill into a chip rather than tinting the ground behind it', async () => {
    const setup = await mount(
      footer({ width: 140, items: [PR, SHELLS], strip: { itemId: 'shells' } }),
      140,
    )
    try {
      const rows = (await drawn(setup)).split('\n')
      const row = rows.findIndex((line) => line.includes('2/3'))
      const column = (rows[row] ?? '').indexOf('⏺ 2/3')

      const spans = setup.captureSpans() as unknown as Spans
      expect(groundAt(spans, row, column)?.equals(parseColor(theme.hover))).toBe(true)
      expect(inkAt(spans, row, column)?.equals(parseColor(theme.appBg))).toBe(true)
      expect(groundAt(spans, row, column - 2)?.equals(parseColor(theme.hover))).toBe(false)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('overrides every tone the pill spells itself in, not just the one behind it', async () => {
    const setup = await mount(
      footer({ width: 140, items: [PR, SHELLS], strip: { itemId: 'pr' } }),
      140,
    )
    try {
      const rows = (await drawn(setup)).split('\n')
      const row = rows.findIndex((line) => line.includes('PR #123'))
      const label = (rows[row] ?? '').indexOf('PR #123')
      const check = (rows[row] ?? '').indexOf('✓')

      const spans = setup.captureSpans() as unknown as Spans
      expect(inkAt(spans, row, label)?.equals(parseColor(theme.appBg))).toBe(true)
      expect(inkAt(spans, row, check)?.equals(parseColor(theme.appBg))).toBe(true)
      expect(groundAt(spans, row, check)?.equals(parseColor(theme.hover))).toBe(true)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('reads as selected rather than merely hovered when the pointer rests on the chip', async () => {
    const setup = await mount(
      footer({ width: 140, items: [PR, SHELLS], strip: { itemId: 'shells' } }),
      140,
    )
    try {
      const rows = (await drawn(setup)).split('\n')
      const row = rows.findIndex((line) => line.includes('2/3'))
      const selected = (rows[row] ?? '').indexOf('⏺ 2/3') + 2
      const unselected = (rows[row] ?? '').indexOf('PR #123') + 2

      await act(async () => {
        await setup.mockMouse.moveTo(unselected, row)
      })
      await setup.flush()
      const hovering = setup.captureSpans() as unknown as Spans
      expect(groundAt(hovering, row, unselected)?.equals(parseColor(theme.hoverBg))).toBe(true)

      await act(async () => {
        await setup.mockMouse.moveTo(selected, row)
      })
      await setup.flush()
      const both = setup.captureSpans() as unknown as Spans
      expect(groundAt(both, row, selected)?.equals(parseColor(theme.hover))).toBe(true)
      expect(groundAt(both, row, selected)?.equals(parseColor(theme.hoverBg))).toBe(false)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('activates the pill that was clicked', async () => {
    const activated: string[] = []
    const setup = await mount(
      footer({
        width: 140,
        items: [PR, SHELLS],
        onActivateItem: (item) => activated.push(item.id),
      }),
      140,
    )
    try {
      const rows = (await drawn(setup)).split('\n')
      const row = rows.findIndex((line) => line.includes('PR #123'))
      const column = (rows[row] ?? '').indexOf('PR #123') + 2

      await act(async () => {
        await setup.mockMouse.click(column, row)
      })
      await setup.flush()

      expect(activated).toEqual(['pr'])
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('activates nothing when the separator between two pills is clicked', async () => {
    const activated: string[] = []
    const setup = await mount(
      footer({
        width: 140,
        items: [PR, SHELLS],
        onActivateItem: (item) => activated.push(item.id),
      }),
      140,
    )
    try {
      const rows = (await drawn(setup)).split('\n')
      const row = rows.findIndex((line) => line.includes('PR #123'))
      const column = (rows[row] ?? '').indexOf('⏺ 2/3') - 2

      await act(async () => {
        await setup.mockMouse.click(column, row)
      })
      await setup.flush()

      expect(activated).toEqual([])
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('leaves the band where the arrows left it when a pill is clicked', async () => {
    const activated: string[] = []
    const setup = await mount(
      footer({
        width: 140,
        items: [PR, SHELLS],
        strip: { itemId: 'shells' },
        onActivateItem: (item) => activated.push(item.id),
      }),
      140,
    )
    try {
      const rows = (await drawn(setup)).split('\n')
      const row = rows.findIndex((line) => line.includes('PR #123'))
      const clicked = (rows[row] ?? '').indexOf('PR #123') + 2
      const banded = (rows[row] ?? '').indexOf('⏺ 2/3') + 2

      await act(async () => {
        await setup.mockMouse.click(clicked, row)
      })
      await setup.flush()

      expect(activated).toEqual(['pr'])
      const spans = setup.captureSpans() as unknown as Spans
      expect(groundAt(spans, row, banded)?.equals(parseColor(theme.hover))).toBe(true)
      expect(groundAt(spans, row, clicked)?.equals(parseColor(theme.hover))).toBe(false)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('fires a pointer-only pill on a click while the band stays on a keyboard one', async () => {
    const activated: string[] = []
    const pointerOnly = pill({
      id: 'pointer',
      spans: [{ text: 'agents 2' }],
      reach: EFooterItemReach.Pointer,
    })

    const setup = await mount(
      footer({
        width: 140,
        items: [pointerOnly, SHELLS],
        strip: { itemId: 'shells' },
        onActivateItem: (item) => activated.push(item.id),
      }),
      140,
    )
    try {
      const rows = (await drawn(setup)).split('\n')
      const row = rows.findIndex((line) => line.includes('agents 2'))
      const clicked = (rows[row] ?? '').indexOf('agents 2') + 2
      const banded = (rows[row] ?? '').indexOf('⏺ 2/3') + 2

      await act(async () => {
        await setup.mockMouse.click(clicked, row)
      })
      await setup.flush()

      expect(activated).toEqual(['pointer'])
      const spans = setup.captureSpans() as unknown as Spans
      expect(groundAt(spans, row, banded)?.equals(parseColor(theme.hover))).toBe(true)
      expect(groundAt(spans, row, clicked)?.equals(parseColor(theme.hover))).toBe(false)
    } finally {
      await teardown(setup)
    }
  }, 30_000)
})
