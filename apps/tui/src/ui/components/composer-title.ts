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

const NOTICE_RUNWAY = 2

/**
 * What is left of the head row for a notice slab once the badge and title have taken their end:
 * the slab grows from the left pad toward them and stops NOTICE_RUNWAY short, so the two never
 * share a cell. Zero means the title already spent the row and the slab stays home.
 */
export function composerNoticeCells(args: {
  width: number
  badge: string | null
  title: string | null
  edge?: EComposerEdge
}): number {
  const closing = args.edge === EComposerEdge.Bordered ? CLOSING_RULE_COLUMNS : 0
  const spent =
    PANEL_PAD * 2 +
    closing +
    NOTICE_RUNWAY +
    (args.badge === null ? 0 : slabCells(args.badge) + 1) +
    (args.title === null ? 0 : slabCells(args.title))

  return Math.max(0, args.width - spent)
}
