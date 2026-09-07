import { describe, expect, it } from 'bun:test'
import { parseColor } from '@opentui/core'
import { testRender } from '@opentui/react/test-utils'
import { act } from 'react'
import React from 'react'

import { EEffort } from '@dltech/atlas-core'

import { Footer } from '../components/footer'
import { hoverGround } from '../components/footer-strip'
import { EFooterItemReach, type FooterItem } from '../footer-item'
import { FOOTER_GUTTER } from '../footer-layout'
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
  spans: [{ text: '#123', fg: theme.appBg }],
  ground: theme.ok,
})

const SHELLS = pill({
  id: 'shells',
  spans: [{ text: '2 shells', fg: theme.appBg }],
  ground: theme.bright,
})

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
  it('spaces the facts apart and marks where the chips begin with the one separator dot', async () => {
    const frame = await frameOf(footer({ width: 140, items: [PR, SHELLS] }), 140)
    expect(rowOf(frame).trimStart()).toStartWith(`${MODEL} med · #123 2 shells`)
  })

  it('leaves the read-out flush against the far edge', async () => {
    const frame = await frameOf(footer({ width: 140, items: [PR, SHELLS] }), 140)
    const row = rowOf(frame)
    expect(row).toEndWith('124.0k 62%')
    expect(cellsOf(row)).toBe(140 - FOOTER_GUTTER)
  })

  it('wraps the pills beneath the facts rather than shedding one when the row gets crammed', async () => {
    const frame = await frameOf(footer({ width: 28, items: [PR, SHELLS] }), 28)
    const rows = frame
      .split('\n')
      .map((row) => row.trimEnd())
      .filter((row) => row.trim().length > 0)

    expect(rows).toHaveLength(2)
    expect(rows[0]?.trimStart()).toStartWith(`${MODEL} med`)
    expect(rows[0]).toEndWith('124.0k 62%')
    expect(rows[1]?.trimStart()).toStartWith('#123 2 shells')
    expect(rows[1]).not.toContain('·')
  })

  it('says nothing only once even the wrapped head row runs out', async () => {
    const frame = await frameOf(footer({ width: 17, items: [PR, SHELLS] }), 17)
    expect(frame).not.toContain('#123')
    expect(frame).not.toContain('2 shells')
  })

  it('fills each pill with the ground its builder chose', async () => {
    const setup = await mount(footer({ width: 140, items: [PR, SHELLS] }), 140)
    try {
      const rows = (await drawn(setup)).split('\n')
      const row = rows.findIndex((line) => line.includes('#123'))

      const spans = setup.captureSpans() as unknown as Spans
      const pr = (rows[row] ?? '').indexOf('#123')
      const shells = (rows[row] ?? '').indexOf('2 shells')
      expect(groundAt(spans, row, pr)?.equals(parseColor(theme.ok))).toBe(true)
      expect(groundAt(spans, row, shells)?.equals(parseColor(theme.bright))).toBe(true)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('inverts the selected pill rather than keeping its own fill', async () => {
    const setup = await mount(
      footer({ width: 140, items: [PR, SHELLS], strip: { itemId: 'shells' } }),
      140,
    )
    try {
      const rows = (await drawn(setup)).split('\n')
      const row = rows.findIndex((line) => line.includes('2 shells'))
      const column = (rows[row] ?? '').indexOf('2 shells')

      const spans = setup.captureSpans() as unknown as Spans
      expect(groundAt(spans, row, column)?.equals(parseColor(theme.hover))).toBe(true)
      expect(inkAt(spans, row, column)?.equals(parseColor(theme.appBg))).toBe(true)
      expect(groundAt(spans, row, column - 2)?.equals(parseColor(theme.hover))).toBe(false)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('overrides the ink the pill spells itself in when the band reaches it', async () => {
    const setup = await mount(
      footer({ width: 140, items: [PR, SHELLS], strip: { itemId: 'pr' } }),
      140,
    )
    try {
      const rows = (await drawn(setup)).split('\n')
      const row = rows.findIndex((line) => line.includes('#123'))
      const label = (rows[row] ?? '').indexOf('#123')

      const spans = setup.captureSpans() as unknown as Spans
      expect(inkAt(spans, row, label)?.equals(parseColor(theme.appBg))).toBe(true)
      expect(groundAt(spans, row, label)?.equals(parseColor(theme.hover))).toBe(true)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('shifts a filled pill toward contrast under the pointer rather than washing it out', async () => {
    const setup = await mount(footer({ width: 140, items: [PR, SHELLS] }), 140)
    try {
      const rows = (await drawn(setup)).split('\n')
      const row = rows.findIndex((line) => line.includes('#123'))
      const pr = (rows[row] ?? '').indexOf('#123') + 1
      const shells = (rows[row] ?? '').indexOf('2 shells') + 2

      await act(async () => {
        await setup.mockMouse.moveTo(pr, row)
      })
      await setup.flush()

      const dark = setup.captureSpans() as unknown as Spans
      expect(groundAt(dark, row, pr)?.equals(parseColor(hoverGround(theme.ok)))).toBe(true)
      expect(groundAt(dark, row, pr)?.equals(parseColor(theme.ok))).toBe(false)

      await act(async () => {
        await setup.mockMouse.moveTo(shells, row)
      })
      await setup.flush()

      const light = setup.captureSpans() as unknown as Spans
      expect(groundAt(light, row, shells)?.equals(parseColor(hoverGround(theme.bright)))).toBe(true)
      expect(groundAt(light, row, shells)?.equals(parseColor(theme.bright))).toBe(false)
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
      const row = rows.findIndex((line) => line.includes('#123'))
      const column = (rows[row] ?? '').indexOf('#123') + 2

      await act(async () => {
        await setup.mockMouse.click(column, row)
      })
      await setup.flush()

      expect(activated).toEqual(['pr'])
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('activates nothing when the gap between two pills is clicked', async () => {
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
      const row = rows.findIndex((line) => line.includes('#123'))
      const column = (rows[row] ?? '').indexOf('2 shells') - 1

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
      const row = rows.findIndex((line) => line.includes('#123'))
      const clicked = (rows[row] ?? '').indexOf('#123') + 2
      const banded = (rows[row] ?? '').indexOf('2 shells') + 2

      await act(async () => {
        await setup.mockMouse.click(clicked, row)
      })
      await setup.flush()

      expect(activated).toEqual(['pr'])
      const spans = setup.captureSpans() as unknown as Spans
      expect(groundAt(spans, row, banded)?.equals(parseColor(theme.hover))).toBe(true)
      expect(groundAt(spans, row, clicked)?.equals(parseColor(theme.ok))).toBe(true)
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
      const banded = (rows[row] ?? '').indexOf('2 shells') + 2

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
