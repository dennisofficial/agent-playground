import type { CliRenderer, MouseEvent, Renderable } from '@opentui/core'
import { useRenderer } from '@opentui/react'
import { useCallback, useRef } from 'react'

import { screenRow } from './screen-rows'
import { wordSpanAt, type WordSpan } from './word-span'

export const DOUBLE_CLICK_MS = 400

const LEFT_BUTTON = 0

type Press = { readonly x: number; readonly y: number; readonly at: number }

type Anchor = { readonly holder: Renderable; readonly y: number; readonly span: WordSpan }

const spanUnder = (args: { renderer: CliRenderer; x: number; y: number }): WordSpan | null =>
  wordSpanAt({ row: screenRow({ renderer: args.renderer, y: args.y }), column: args.x })

const cellSpan = (x: number): WordSpan => ({ start: x, end: x + 1 })

function stretch(args: {
  renderer: CliRenderer
  anchor: Anchor
  focus: { y: number; span: WordSpan; target: Renderable }
}): void {
  const { anchor, focus, renderer } = args
  const backwards =
    focus.y < anchor.y || (focus.y === anchor.y && focus.span.start < anchor.span.start)

  const from = backwards ? anchor.span.end : anchor.span.start
  const to = backwards ? focus.span.start : focus.span.end

  renderer.startSelection(anchor.holder, from, anchor.y)
  renderer.updateSelection(focus.target, to, focus.y)
}

export function useWordSelect(): (event: MouseEvent) => void {
  const renderer = useRenderer()
  const press = useRef<Press | null>(null)
  const anchor = useRef<Anchor | null>(null)

  return useCallback(
    (event: MouseEvent) => {
      if (event.button !== LEFT_BUTTON) return

      const target = event.target
      if (target === null) return

      if (event.type === 'down') {
        const at = Date.now()
        const previous = press.current
        press.current = { x: event.x, y: event.y, at }
        anchor.current = null

        const doubled =
          previous !== null &&
          at - previous.at <= DOUBLE_CLICK_MS &&
          previous.y === event.y &&
          Math.abs(previous.x - event.x) <= 1
        if (!doubled || !target.selectable) return

        const span = spanUnder({ renderer, x: event.x, y: event.y })
        if (span === null) return

        press.current = null
        const settled: Anchor = { holder: target, y: event.y, span }
        anchor.current = settled
        stretch({ renderer, anchor: settled, focus: { ...settled, target } })
        return
      }

      if (event.type !== 'drag') return

      const settled = anchor.current
      if (settled === null) return

      const span = spanUnder({ renderer, x: event.x, y: event.y }) ?? cellSpan(event.x)
      stretch({ renderer, anchor: settled, focus: { y: event.y, span, target } })
    },
    [renderer],
  )
}
