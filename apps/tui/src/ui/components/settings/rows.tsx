import type { ResolvedSetting } from '@dltech/atlas-core'
import React from 'react'

import { cellsOf } from '../../hint-layout'
import { type PressHandlers } from '../../hooks/use-press'
import { affordanceHint, valueColour, valueLabel } from '../../settings-format'
import { glyph, theme } from '../../theme'
import { clipSpans, spanCells, truncateCells } from '../sidebar/cells'
import { Spans, type Span } from '../spans'

export const SETTINGS_PAD = 2

export const SETTINGS_LABEL_CELLS = 28

const MARK_CELLS = 2

const GAP = 1

export function SettingsLine(props: {
  band?: string
  press?: PressHandlers
  children: React.ReactNode
}): React.ReactNode {
  return (
    <box
      height={1}
      flexShrink={0}
      paddingLeft={SETTINGS_PAD}
      paddingRight={SETTINGS_PAD}
      {...(props.band === undefined ? {} : { backgroundColor: props.band })}
      {...(props.press ?? {})}
    >
      {props.children}
    </box>
  )
}

export function SettingsGroupHeader(props: { label: string }): React.ReactNode {
  return (
    <SettingsLine>
      <text fg={theme.meta}>{props.label.toUpperCase()}</text>
    </SettingsLine>
  )
}

const labelColumn = (cells: number): number =>
  Math.max(0, Math.min(SETTINGS_LABEL_CELLS, Math.floor(cells / 2)))

const paddedLabel = (args: { label: string; cells: number }): string => {
  const kept = truncateCells({ text: args.label, cells: args.cells })
  return `${kept}${' '.repeat(Math.max(0, args.cells - cellsOf(kept)))}`
}

function readOut(args: { setting: ResolvedSetting; cells: number }): Span[] {
  const { definition, value } = args.setting
  const shown: Span = {
    text: valueLabel({ definition, value }),
    fg: valueColour({ definition, value }),
  }
  const affordance: Span = { text: affordanceHint(definition), fg: theme.hint }

  const room = Math.max(0, args.cells)
  const together = spanCells([shown]) + GAP + spanCells([affordance])
  if (together > room) {
    return [{ ...shown, text: truncateCells({ text: shown.text, cells: room }) }]
  }

  return [shown, { text: ' '.repeat(room - together + GAP) }, affordance]
}

export function SettingLine(props: {
  setting: ResolvedSetting
  cells: number
  selected: boolean
  press?: PressHandlers
}): React.ReactNode {
  const labelCells = labelColumn(props.cells)
  const mark: Span = props.selected
    ? { text: `${glyph.selected} `, fg: theme.accent }
    : { text: ' '.repeat(MARK_CELLS) }

  const spans: Span[] = [
    mark,
    {
      text: paddedLabel({ label: props.setting.definition.label, cells: labelCells }),
      fg: props.selected ? theme.bright : theme.hover,
    },
    { text: ' ' },
    ...readOut({
      setting: props.setting,
      cells: props.cells - MARK_CELLS - labelCells - GAP,
    }),
  ]

  return (
    <SettingsLine
      {...(props.selected ? { band: theme.hoverBg } : {})}
      {...(props.press === undefined ? {} : { press: props.press })}
    >
      <text>
        <Spans spans={clipSpans({ spans, cells: props.cells })} />
      </text>
    </SettingsLine>
  )
}
