import { parseColor, type CapturedFrame, type RGBA } from '@opentui/core'
import { testRender } from '@opentui/react/test-utils'
import React, { act } from 'react'

import { grammarsReady, settle, teardown } from '../../../markdown/__tests__/harness'
import { PANEL_INSET } from '../../panel'
import { DIFF_CHROME } from '../inline-diff'

export const HEIGHT = 40

export type Mounted = {
  rows: string[]
  frame: CapturedFrame
}

export async function shown(args: { node: React.ReactNode; width: number }): Promise<Mounted> {
  await grammarsReady()
  const setup = await testRender(
    <box flexDirection="column" width={args.width} height={HEIGHT}>
      {args.node}
    </box>,
    { width: args.width, height: HEIGHT },
  )
  try {
    await act(async () => {
      await setup.flush()
      await settle()
    })
    await setup.flush()
    return { rows: setup.captureCharFrame().split('\n'), frame: setup.captureSpans() }
  } finally {
    await teardown(setup)
  }
}

export const rowOf = (rows: readonly string[], needle: string): number =>
  rows.findIndex((row) => row.includes(needle))

export type Cell = { char: string; fg: RGBA; bg: RGBA }

export function cellsOfRow(args: { frame: CapturedFrame; row: number }): Cell[] {
  const line = args.frame.lines[args.row]
  if (line === undefined) return []
  return line.spans.flatMap((span) =>
    [...span.text].map((char) => ({ char, fg: span.fg, bg: span.bg })),
  )
}

export const isColour = (args: { cell: Cell | undefined; colour: string }): boolean =>
  args.cell !== undefined && args.cell.bg.equals(parseColor(args.colour))

export const CONTENT_LEFT = PANEL_INSET

export const contentColumns = (width: number): number => width - DIFF_CHROME
