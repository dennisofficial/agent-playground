import type { CliRenderer, Renderable, Selection } from '@opentui/core'

import { firstInkedColumn, lastInkedColumn } from './screen-rows'
import { sourceSpanOf } from './source-spans'

type Reach = { readonly top: number; readonly bottom: number; readonly from: number; readonly to: number }

type Piece = { readonly x: number; readonly text: string }

const reachOf = (selection: Selection): Reach => {
  const { anchor, focus } = selection
  const forwards = anchor.y < focus.y || (anchor.y === focus.y && anchor.x <= focus.x)
  const head = forwards ? anchor : focus
  const tail = forwards ? focus : anchor

  return { top: head.y, bottom: tail.y, from: head.x, to: tail.x }
}

const wholly = (args: { holder: Renderable; reach: Reach; renderer: CliRenderer }): boolean => {
  const { holder, reach, renderer } = args
  const top = holder.y
  const bottom = holder.y + Math.max(1, holder.height) - 1
  const right = holder.x + Math.max(1, holder.width) - 1
  if (top < reach.top || bottom > reach.bottom) return false

  if (top === reach.top) {
    const ink = firstInkedColumn({ renderer, y: top, from: holder.x, to: right })
    if (reach.from > ink) return false
  }

  if (bottom === reach.bottom) {
    const ink = lastInkedColumn({ renderer, y: bottom, from: holder.x, to: right })
    if (reach.to <= ink) return false
  }

  return true
}

export function selectedText(args: { selection: Selection; renderer: CliRenderer }): string {
  const reach = reachOf(args.selection)
  const rows = new Map<number, Piece[]>()
  const spent = new Set<Renderable>()

  const add = (piece: { y: number; x: number; text: string }): void => {
    const row = rows.get(piece.y) ?? []
    row.push({ x: piece.x, text: piece.text })
    rows.set(piece.y, row)
  }

  for (const renderable of args.selection.selectedRenderables) {
    if (renderable.isDestroyed) continue

    const span = sourceSpanOf(renderable)
    if (span !== null && wholly({ holder: span.holder, reach, renderer: args.renderer })) {
      if (spent.has(span.holder)) continue
      spent.add(span.holder)
      add({ y: span.holder.y, x: span.holder.x, text: `${span.source.trimEnd()}\n` })
      continue
    }

    const text = renderable.getSelectedText()
    if (!text) continue

    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      add({ y: renderable.y + index, x: renderable.x, text: lines[index] ?? '' })
    }
  }

  return [...rows.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, pieces]) =>
      pieces
        .sort((left, right) => left.x - right.x)
        .map((piece) => piece.text)
        .join(''),
    )
    .join('\n')
    .trimEnd()
}
