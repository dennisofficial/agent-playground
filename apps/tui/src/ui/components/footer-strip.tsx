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
 */
function FooterPill(
  props: { item: FooterItem; selected: boolean } & FooterStripHandlers,
): React.ReactNode {
  const { item, selected, onActivate } = props
  const activation = pressOf(item)

  const region = useClickRegion(activation === undefined ? undefined : () => onActivate?.(item))

  const ground = selected ? SELECTED_GROUND : region.wash.bg
  const ink = selected ? SELECTED_INK : undefined
  const spans = washed({ spans: item.spans, bg: ground, fg: ink })

  return (
    <box
      flexShrink={0}
      width={footerItemCells(item)}
      {...(ground === undefined ? {} : { backgroundColor: ground })}
      {...region.handlers}
    >
      <text flexShrink={0}>
        <Spans spans={spans} />
      </text>
    </box>
  )
}

const Separator = (): React.ReactNode => (
  <text flexShrink={0}>
    <span fg={theme.rule}>{HINT_SEPARATOR}</span>
  </text>
)

/**
 * The separator sits outside the pressable box on purpose: a click on the ` · ` between two pills
 * belongs to neither of them.
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
        ...(index === 0 && !lead ? [] : [<Separator key={`${item.id}-lead`} />]),
        <FooterPill
          key={item.id}
          item={item}
          selected={item.id === selectedId}
          {...(onActivate === undefined ? {} : { onActivate })}
        />,
      ])}
    </>
  )
}
