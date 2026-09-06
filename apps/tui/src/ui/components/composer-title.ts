import { EComposerEdge } from '../composer-edge-store'
import { cellsOf } from '../hint-layout'
import { PANEL_PAD } from './panel'
import { truncateCells } from './sidebar/cells'

const TITLE_PAD = 1

const TITLE_MIN_CELLS = 8

const RAIL_COLUMNS = 1

const CLOSING_RULE_COLUMNS = 1

const TITLE_RUNWAY = 4

const slabCells = (text: string): number => cellsOf(text) + TITLE_PAD * 2

/**
 * The head row is shared: whatever the badge takes, plus the `▄` between them, is gone before the
 * title starts. Below `TITLE_MIN_CELLS` of what is left there is no title worth truncating to. A
 * bordered composer closes the row on a corner as well, so it has one column less to give.
 */
export function composerTitle(args: {
  title: string
  width: number
  badge: string | null
  edge?: EComposerEdge
}): string | null {
  const closing = args.edge === EComposerEdge.Bordered ? CLOSING_RULE_COLUMNS : 0
  const spent =
    RAIL_COLUMNS +
    TITLE_RUNWAY +
    PANEL_PAD +
    closing +
    (args.badge === null ? 0 : slabCells(args.badge) + 1)
  const room = args.width - spent - TITLE_PAD * 2
  if (room < TITLE_MIN_CELLS) return null

  return truncateCells({ text: args.title, cells: room })
}
