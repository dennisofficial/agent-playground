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

export type ComposerFoot = { model: string; effort: string | null }

const FOOT_MIN_CELLS = 8

const FOOT_RUNWAY = 4

const FOOT_SEPARATOR_CELLS = 3

/**
 * The mirror of `composerTitle` on the tail rule: the effort word sheds first, the model truncates
 * only after it is alone, and below FOOT_MIN_CELLS the rule stays bare rather than clipping a name
 * to nothing. The inset and runway hold the label clear of the corners the way the title's do.
 */
export function composerFoot(args: {
  foot: ComposerFoot
  width: number
  edge?: EComposerEdge
}): ComposerFoot | null {
  const closing = args.edge === EComposerEdge.Bordered ? CLOSING_RULE_COLUMNS : 0
  const room = args.width - PANEL_PAD - FOOT_RUNWAY - closing - TITLE_PAD * 2
  if (room < FOOT_MIN_CELLS) return null

  const effortCells =
    args.foot.effort === null ? 0 : FOOT_SEPARATOR_CELLS + cellsOf(args.foot.effort)
  if (cellsOf(args.foot.model) + effortCells <= room) return args.foot
  if (cellsOf(args.foot.model) <= room) return { model: args.foot.model, effort: null }

  return { model: truncateCells({ text: args.foot.model, cells: room }), effort: null }
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
