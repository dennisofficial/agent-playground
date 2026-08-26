import type { SettingPage } from '@dltech/atlas-core'
import React from 'react'

import { cellsOf } from '../../hint-layout'
import { glyph, theme } from '../../theme'
import { clipSpans, spanCells, truncateCells } from '../sidebar/cells'
import { Spans, type Span } from '../spans'
import { SETTINGS_PAD } from './rows'

const TITLE = 'settings'

const TAB_GAP = '  '

const DIVIDER = ' │ '

const GAP_CELLS = 1

const tabSpans = (args: {
  pages: readonly SettingPage[]
  pageIndex: number
}): Span[] =>
  args.pages.flatMap((page, index) => [
    ...(index === 0 ? [] : [{ text: TAB_GAP }]),
    { text: page.label, fg: index === args.pageIndex ? theme.accent : theme.hint },
  ])

export function SettingsHead(props: {
  cells: number
  pages: readonly SettingPage[]
  pageIndex: number
  origin: string
}): React.ReactNode {
  const left: Span[] = [
    { text: `${glyph.block} `, fg: theme.accent },
    { text: TITLE, fg: theme.hover },
    { text: DIVIDER, fg: theme.rule },
    ...tabSpans({ pages: props.pages, pageIndex: props.pageIndex }),
  ]

  const room = props.cells - spanCells(left) - GAP_CELLS
  const origin = room <= 0 ? '' : truncateCells({ text: props.origin, cells: room })
  const gap = Math.max(GAP_CELLS, props.cells - spanCells(left) - cellsOf(origin))

  return (
    <box
      height={1}
      flexShrink={0}
      paddingLeft={SETTINGS_PAD}
      paddingRight={SETTINGS_PAD}
      backgroundColor={theme.panelBg}
    >
      <text>
        <Spans
          spans={clipSpans({
            spans: [...left, { text: ' '.repeat(gap) }, { text: origin, fg: theme.hint }],
            cells: props.cells,
          })}
        />
      </text>
    </box>
  )
}
