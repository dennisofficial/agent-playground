import { parseColor } from '@opentui/core'
import { testRender } from '@opentui/react/test-utils'
import { afterEach, describe, expect, it } from 'bun:test'
import React from 'react'

import {
  FRAME_BOTTOM_LEFT,
  FRAME_BOTTOM_RIGHT,
  FRAME_HORIZONTAL,
  FRAME_TOP_LEFT,
  FRAME_TOP_RIGHT,
  FRAME_VERTICAL,
  PANEL_BOTTOM_EDGE,
  PANEL_TOP_EDGE,
  RAIL,
  RAIL_HEAD,
  RAIL_TAIL,
} from '../borders'
import { applyComposerEdge, EComposerEdge, SHIPPED_COMPOSER_EDGE } from '../composer-edge-store'
import {
  Composer,
  composerNoticeCells,
  composerTitle,
  composerTone,
  EComposerTone,
} from '../components/composer'
import { FRAME_INSET } from '../components/frame'
import { PANEL_INSET, PANEL_PAD } from '../components/panel'
import { ComposerHints, type Hint } from '../components/composer-hints'
import { useDraft } from '../hooks/use-draft'
import { grammarsReady, teardown } from '../markdown/__tests__/harness'
import { dismissNotice, ENoticeTone, notify } from '../notice-store'
import { glyph, theme } from '../theme'
import { drawn, frameOf, HEIGHT } from './transcript-fixture'

await grammarsReady()

afterEach(() => {
  applyComposerEdge(SHIPPED_COMPOSER_EDGE)
  dismissNotice()
})

const WIDTH = 60

const PLACEHOLDER = 'Ask anything'

const LONG_DRAFT = 'wrap '.repeat(60)

const TITLE = 'Refresh-token rotation'

const NOTICE = 'copied 3 lines'

function Draft(props: {
  text?: string
  tone?: EComposerTone
  maxRows?: number
  title?: string
  width?: number
}): React.ReactNode {
  const draft = useDraft(props.text ?? '')
  return (
    <Composer
      draft={draft}
      width={props.width ?? WIDTH}
      placeholder={PLACEHOLDER}
      {...(props.tone === undefined ? {} : { tone: props.tone })}
      {...(props.maxRows === undefined ? {} : { maxRows: props.maxRows })}
      {...(props.title === undefined ? {} : { title: props.title })}
    />
  )
}

describe('composerTone', () => {
  it('reads idle between turns', () => {
    expect(composerTone({ working: false, interrupting: false })).toBe(EComposerTone.Idle)
  })

  it('reads working while a turn runs', () => {
    expect(composerTone({ working: true, interrupting: false })).toBe(EComposerTone.Working)
  })

  it('lets interrupting outrank working', () => {
    expect(composerTone({ working: true, interrupting: true })).toBe(EComposerTone.Interrupting)
  })
})

describe('the composer', () => {
  it('marks the draft with a rail rather than a frame', async () => {
    const frame = await frameOf(<Draft />, WIDTH)
    expect(frame).toContain(`${RAIL}  ${PLACEHOLDER}`)
    for (const corner of ['╭', '╮', '╰', '╯']) expect(frame).not.toContain(corner)
  })

  it('runs the rail down every row a wrapped draft takes', async () => {
    const frame = await frameOf(<Draft text={LONG_DRAFT} />, WIDTH)
    const rows = frame.split('\n').filter((row) => row.startsWith(RAIL))
    expect(rows.length).toBeGreaterThan(1)
  })

  it('opens and closes the panel on a half row at both ends', async () => {
    const frame = await frameOf(<Draft />, WIDTH)
    const rows = frame.split('\n')
    expect(rows.find((row) => row.startsWith(RAIL_HEAD))).toContain(
      PANEL_TOP_EDGE.repeat(WIDTH - 1),
    )
    expect(rows.find((row) => row.startsWith(RAIL_TAIL))).toContain(
      PANEL_BOTTOM_EDGE.repeat(WIDTH - 1),
    )
  })

  it('sets the hidden-row count into the head band rather than taking a row', async () => {
    const frame = await frameOf(<Draft text={LONG_DRAFT} maxRows={2} />, WIDTH)
    const badge = frame.split('\n').find((row) => row.includes('more rows'))
    expect(badge).toStartWith(RAIL_HEAD)
    expect(badge).toContain(`${PANEL_TOP_EDGE} ⋯ 4 more rows ${PANEL_TOP_EDGE}`)
  })

  it('says nothing about hidden rows when the whole draft is showing', async () => {
    const frame = await frameOf(<Draft text="one row" />, WIDTH)
    expect(frame).not.toContain('more row')
  })
})

type Colour = { equals: (other: unknown) => boolean }

type Span = { text: string; bg: Colour }

type Spans = { lines: ({ spans: Span[] } | undefined)[] }

const groundAt = (spans: Spans, row: number, cell: number): Colour | undefined => {
  let column = 0
  for (const span of spans.lines[row]?.spans ?? []) {
    for (const _char of span.text) {
      if (column === cell) return span.bg
      column += 1
    }
  }
  return undefined
}

async function groundOnHead(node: React.ReactNode, cell: number): Promise<Colour | undefined> {
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={HEIGHT}>
      {node}
    </box>,
    { width: WIDTH, height: HEIGHT },
  )
  try {
    const rows = (await drawn(setup)).split('\n')
    const head = rows.findIndex((row) => row.startsWith(RAIL_HEAD))
    return groundAt(setup.captureSpans() as Spans, head, cell)
  } finally {
    await teardown(setup)
  }
}

async function groundOf(node: React.ReactNode, cell: number): Promise<Colour | undefined> {
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={HEIGHT}>
      {node}
    </box>,
    { width: WIDTH, height: HEIGHT },
  )
  try {
    const rows = (await drawn(setup)).split('\n')
    const body = rows.findIndex((row) => row.includes(PLACEHOLDER))
    return groundAt(setup.captureSpans() as Spans, body, cell)
  } finally {
    await teardown(setup)
  }
}

describe('the composer notice', () => {
  it('sets a notice into the head row rather than spending a row on it', async () => {
    notify({ text: NOTICE })
    const rows = (await frameOf(<Draft />, WIDTH)).split('\n')

    const head = rows.find((row) => row.startsWith(RAIL_HEAD))
    expect(head).toContain(`${PANEL_TOP_EDGE} ${NOTICE} ${PANEL_TOP_EDGE}`)
    expect(rows.filter((row) => row.includes(NOTICE)).length).toBe(1)
  })

  it('leaves the head row alone while nothing is being said', async () => {
    const frame = await frameOf(<Draft />, WIDTH)
    const head = frame.split('\n').find((row) => row.startsWith(RAIL_HEAD))

    expect(head).toBe(`${RAIL_HEAD}${PANEL_TOP_EDGE.repeat(WIDTH - 1)}`)
  })

  it('says a notice on the same rule the title is set into', async () => {
    notify({ text: NOTICE })
    const rows = (await frameOf(<Draft title={TITLE} />, WIDTH)).split('\n')

    const head = rows.find((row) => row.startsWith(RAIL_HEAD))
    expect(head).toContain(NOTICE)
    expect(head).toContain(TITLE)
  })

  it('truncates the notice rather than letting it run into the title', async () => {
    const room = composerNoticeCells({ width: WIDTH, badge: null, title: TITLE })
    const bare = composerNoticeCells({ width: WIDTH, badge: null, title: null })

    expect(room).toBeLessThan(bare)
    expect(room).toBe(bare - TITLE.length - 2)
  })

  it("grounds the notice on the composer's own fill rather than an accent slab", async () => {
    notify({ text: NOTICE, tone: ENoticeTone.Warn })
    const ground = await groundOnHead(<Draft />, PANEL_INSET)

    expect(ground?.equals(parseColor(theme.panelBg))).toBe(true)
    expect(ground?.equals(parseColor(theme.accent))).toBe(false)
  })
})

describe('the bordered composer', () => {
  it('rules all four sides instead of marking only the left', async () => {
    applyComposerEdge(EComposerEdge.Bordered)
    const rows = (await frameOf(<Draft />, WIDTH)).split('\n')

    const head = rows.findIndex((row) => row.startsWith(FRAME_TOP_LEFT))
    const body = rows.findIndex((row) => row.includes(PLACEHOLDER))
    const tail = rows.findIndex((row) => row.startsWith(FRAME_BOTTOM_LEFT))

    expect(rows[head]).toBe(
      `${FRAME_TOP_LEFT}${FRAME_HORIZONTAL.repeat(WIDTH - 2)}${FRAME_TOP_RIGHT}`,
    )
    expect(rows[tail]).toBe(
      `${FRAME_BOTTOM_LEFT}${FRAME_HORIZONTAL.repeat(WIDTH - 2)}${FRAME_BOTTOM_RIGHT}`,
    )
    expect(rows[body]?.startsWith(FRAME_VERTICAL)).toBe(true)
    expect(rows[body]?.endsWith(FRAME_VERTICAL)).toBe(true)
  })

  it('leaves the rail and its half rows behind', async () => {
    applyComposerEdge(EComposerEdge.Bordered)
    const frame = await frameOf(<Draft />, WIDTH)

    for (const glyph of [RAIL, RAIL_HEAD, RAIL_TAIL, PANEL_TOP_EDGE, PANEL_BOTTOM_EDGE]) {
      expect(frame).not.toContain(glyph)
    }
  })

  it('drops the second ground the slab raises itself on', async () => {
    const slab = await groundOf(<Draft />, PANEL_INSET)
    applyComposerEdge(EComposerEdge.Bordered)
    const bordered = await groundOf(<Draft />, FRAME_INSET)

    expect(slab?.equals(parseColor(theme.panelBg))).toBe(true)
    expect(bordered?.equals(parseColor(theme.panelBg))).toBe(false)
  })

  it('sets the title into the top rule', async () => {
    applyComposerEdge(EComposerEdge.Bordered)
    const rows = (await frameOf(<Draft title={TITLE} />, WIDTH)).split('\n')
    const head = rows.find((row) => row.startsWith(FRAME_TOP_LEFT))

    expect(head).toContain(`${FRAME_HORIZONTAL} ${TITLE} ${FRAME_HORIZONTAL}`)
    expect(head).toEndWith(`${FRAME_HORIZONTAL}${FRAME_TOP_RIGHT}`)
  })

  it('gives the corner its column back, so the title truncates a cell sooner', () => {
    const slab = composerTitle({ title: TITLE, width: 30, badge: null })
    const bordered = composerTitle({
      title: TITLE,
      width: 30,
      badge: null,
      edge: EComposerEdge.Bordered,
    })

    expect(bordered?.length ?? 0).toBe((slab?.length ?? 0) - 1)
  })

  it('seats the hidden-row badge beside the title on the same rule', async () => {
    applyComposerEdge(EComposerEdge.Bordered)
    const frame = await frameOf(<Draft text={LONG_DRAFT} maxRows={2} title={TITLE} />, WIDTH)
    const head = frame.split('\n').find((row) => row.startsWith(FRAME_TOP_LEFT)) ?? ''

    expect(head.indexOf('more rows')).toBeGreaterThan(0)
    expect(head.indexOf('more rows')).toBeLessThan(head.indexOf(TITLE))
  })
})

describe('the claude composer', () => {
  it('rules above and below but leaves the sides open', async () => {
    applyComposerEdge(EComposerEdge.Claude)
    const rows = (await frameOf(<Draft />, WIDTH)).split('\n')

    const ruled = rows.filter((row) => row === FRAME_HORIZONTAL.repeat(WIDTH))
    expect(ruled).toHaveLength(2)
    for (const corner of [FRAME_TOP_LEFT, FRAME_TOP_RIGHT, FRAME_BOTTOM_LEFT, FRAME_BOTTOM_RIGHT]) {
      expect(rows.join('\n')).not.toContain(corner)
    }
    expect(rows.join('\n')).not.toContain(FRAME_VERTICAL)
  })

  it('leads the draft with a caret at the margin, one column clear of the text', async () => {
    applyComposerEdge(EComposerEdge.Claude)
    const rows = (await frameOf(<Draft />, WIDTH)).split('\n')
    const body = rows.find((row) => row.includes(PLACEHOLDER)) ?? ''

    expect(body).toStartWith(`${glyph.user} ${PLACEHOLDER}`)
    expect(body.indexOf(PLACEHOLDER)).toBe(2)
  })

  it('indents a wrapped row under the text rather than repeating the caret', async () => {
    applyComposerEdge(EComposerEdge.Claude)
    const rows = (await frameOf(<Draft text={LONG_DRAFT} maxRows={3} />, WIDTH)).split('\n')
    const drafted = rows.filter((row) => row.includes('wrap'))

    expect(drafted.length).toBeGreaterThan(1)
    expect(drafted[0]).toStartWith(`${glyph.user} wrap`)
    for (const row of drafted.slice(1)) {
      expect(row).toStartWith('  wrap')
      expect(row).not.toContain(glyph.user)
    }
  })

  it('sets the title into the top rule, as the bordered reading does', async () => {
    applyComposerEdge(EComposerEdge.Claude)
    const rows = (await frameOf(<Draft title={TITLE} />, WIDTH)).split('\n')
    const head = rows.find((row) => row.startsWith(FRAME_HORIZONTAL))

    expect(head).toContain(`${FRAME_HORIZONTAL} ${TITLE} ${FRAME_HORIZONTAL}`)
  })
})

describe('composerTitle', () => {
  it('keeps a title that fits the head row whole', () => {
    expect(composerTitle({ title: TITLE, width: WIDTH, badge: null })).toBe(TITLE)
  })

  it('truncates rather than pushing the title past the left of the row', () => {
    const fitted = composerTitle({ title: TITLE, width: 28, badge: null })
    expect(fitted).not.toBeNull()
    expect(fitted).toEndWith('…')
    expect(fitted?.length).toBeLessThan(TITLE.length)
  })

  it('gives the badge its cells first, so the two never overlap', () => {
    const alone = composerTitle({ title: TITLE, width: 40, badge: null })
    const shared = composerTitle({ title: TITLE, width: 40, badge: '⋯ 3 more rows' })
    expect(shared?.length ?? 0).toBeLessThan(alone?.length ?? 0)
  })

  it('drops the title outright when the row is too narrow to say anything', () => {
    expect(composerTitle({ title: TITLE, width: 18, badge: '⋯ 3 more rows' })).toBeNull()
  })
})

describe('the composer title', () => {
  it('closes the head row on the half glyph rather than on the title itself', async () => {
    const frame = await frameOf(<Draft title={TITLE} />, WIDTH)
    const head = frame.split('\n').find((row) => row.startsWith(RAIL_HEAD))
    expect(head).toContain(`${PANEL_TOP_EDGE} ${TITLE} ${PANEL_TOP_EDGE}`)
    expect(head?.trimEnd()).toEndWith(PANEL_TOP_EDGE.repeat(PANEL_PAD))
  })

  it('keeps the head row a single row however long the title', async () => {
    const frame = await frameOf(<Draft title={'A very long session title '.repeat(6)} />, WIDTH)
    expect(frame.split('\n').filter((row) => row.startsWith(RAIL_HEAD))).toHaveLength(1)
  })

  it('seats the hidden-row badge to the left of the title rather than under it', async () => {
    const frame = await frameOf(<Draft text={LONG_DRAFT} maxRows={2} title={TITLE} />, WIDTH)
    const head = frame.split('\n').find((row) => row.startsWith(RAIL_HEAD)) ?? ''
    expect(head.indexOf('more rows')).toBeGreaterThan(0)
    expect(head.indexOf('more rows')).toBeLessThan(head.indexOf(TITLE))
  })

  it('says nothing when the session has no title', async () => {
    const frame = await frameOf(<Draft />, WIDTH)
    const head = frame.split('\n').find((row) => row.startsWith(RAIL_HEAD))
    expect(head).toBe(`${RAIL_HEAD}${PANEL_TOP_EDGE.repeat(WIDTH - 1)}`)
  })
})

const HINTS: readonly Hint[] = [
  { key: '⏎', label: 'send' },
  { key: '⇧⏎', label: 'newline' },
  { key: 'ctrl+c', label: 'quit' },
]

describe('the composer hints', () => {
  it('leads with the status and pushes the hints to the right', async () => {
    const frame = await frameOf(
      <ComposerHints width={WIDTH} hints={HINTS} status="~/atlas · a-model" />,
      WIDTH,
    )
    const row = frame.split('\n').find((line) => line.includes('send'))
    expect(row?.trimStart()).toStartWith('~/atlas · a-model')
    expect(row?.trimEnd()).toEndWith('quit')
  })

  it('drops the status rather than colliding with the hints', async () => {
    const frame = await frameOf(
      <ComposerHints width={24} hints={HINTS} status="~/atlas · a-model" />,
      24,
    )
    expect(frame).not.toContain('a-model')
  })

  it('keeps the row to one line however narrow the terminal', async () => {
    const frame = await frameOf(<ComposerHints width={12} hints={HINTS} />, 12)
    const rows = frame.split('\n').filter((line) => line.trim().length > 0)
    expect(rows).toHaveLength(1)
  })
})
