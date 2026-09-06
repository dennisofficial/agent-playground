import React from 'react'

import { footerItemCells, pressOf, type FooterItem } from '../footer-item'
import { HINT_SEPARATOR } from '../hint-layout'
import { useClickRegion } from '../hooks/use-click-region'
import { theme } from '../theme'
import { Spans } from './spans'

export type FooterStripHandlers = {
  onActivate?: (item: FooterItem) => void
}

const SELECTED_GROUND = theme.hover

const SELECTED_INK = theme.appBg

const HOVER_SHIFT = 0.45

const channel = (hex: string, at: number): number => parseInt(hex.slice(at, at + 2), 16)

const shifted = (from: number, toward: number): string =>
  Math.round(from + (toward - from) * HOVER_SHIFT)
    .toString(16)
    .padStart(2, '0')

/**
 * Lifting a light chip toward white is invisible, so the hover reads its luminance first: dark
 * grounds brighten, light grounds sink. The shift is the same size either way.
 */
export const hoverGround = (hex: string): string => {
  const red = channel(hex, 1)
  const green = channel(hex, 3)
  const blue = channel(hex, 5)
  const toward = 0.299 * red + 0.587 * green + 0.114 * blue > 140 ? 0 : 255
  return `#${shifted(red, toward)}${shifted(green, toward)}${shifted(blue, toward)}`
}

const washed = (args: {
  spans: FooterItem['spans']
  bg: string | undefined
  fg: string | undefined
}): FooterItem['spans'] => {
  const { bg, fg } = args
  if (bg === undefined && fg === undefined) return args.spans

  return args.spans.map((span) => ({
    ...span,
    ...(bg === undefined ? {} : { bg }),
    ...(fg === undefined ? {} : { fg }),
  }))
}

/**
 * One `useClickRegion` per pill, never one factory shared down: `usePress` keeps a per-instance
 * origin, so a shared one would fire when a press begun on one pill is released on another.
 *
 * A filled pill answers the pointer by shifting its own ground — brighter for a dark fill, darker
 * for a light one — since the wash would only hide the status the fill is spelling.
 */
function FooterPill(
  props: { item: FooterItem; selected: boolean; marginLeft: number } & FooterStripHandlers,
): React.ReactNode {
  const { item, selected, onActivate } = props
  const activation = pressOf(item)

  const region = useClickRegion(activation === undefined ? undefined : () => onActivate?.(item))

  const fill =
    item.ground === undefined
      ? region.wash.bg
      : region.hovered
        ? hoverGround(item.ground)
        : item.ground
  const ground = selected ? SELECTED_GROUND : fill
  const ink = selected ? SELECTED_INK : undefined
  const spans = washed({ spans: item.spans, bg: ground, fg: ink })

  return (
    <box
      flexShrink={0}
      width={footerItemCells(item)}
      marginLeft={props.marginLeft}
      {...(ground === undefined ? {} : { backgroundColor: ground })}
      {...region.handlers}
    >
      <text flexShrink={0}>
        <Spans spans={spans} />
      </text>
    </box>
  )
}

const Lead = (): React.ReactNode => (
  <text flexShrink={0}>
    <span fg={theme.rule}>{HINT_SEPARATOR}</span>
  </text>
)

/**
 * The dot and the gaps sit outside the pressable box on purpose: a click between two chips belongs
 * to neither of them. The gap is a margin for the same reason a space used to be a text of its own.
 */
export function FooterStrip(
  props: {
    items: readonly FooterItem[]
    lead: boolean
    selectedId: string | null
  } & FooterStripHandlers,
): React.ReactNode {
  const { items, lead, selectedId, onActivate } = props

  return (
    <>
      {items.flatMap((item, index) => [
        ...(index === 0 && lead ? [<Lead key={`${item.id}-lead`} />] : []),
        <FooterPill
          key={item.id}
          item={item}
          selected={item.id === selectedId}
          marginLeft={index === 0 ? 0 : 1}
          {...(onActivate === undefined ? {} : { onActivate })}
        />,
      ])}
    </>
  )
}
