/**
 * What the gutter says, and how loudly.
 *
 * Prose and tool rows drawing the same accent `⏺` gave a transcript no cue for where the agent SAID
 * something versus where it DID something — and tool rows are the majority, so the loud mark was
 * being spent on the common case.
 *
 * The rule every style keeps: the gutter's job is to say "this is not prose"; COLOUR's job is to say
 * "this changed something" or "this went wrong". So a change and a failure keep their tone in every
 * style, and only the quiet majority is turned down.
 */

import { EToolClass } from '../store/tools'
import { theme } from './theme'

export enum EMark {
  /** The accent `⏺`, identical to the assistant's. The control. */
  Accent = 'accent',
  /** The same `⏺`, dropped to the rule colour. */
  Dim = 'dim',
  /** No glyph at all — indent and dim text carry it. */
  Bare = 'bare',
  /** A hairline in the gutter, so tool activity reads as one channel down the page. */
  Rail = 'rail',
}

export const MARK_ORDER: readonly EMark[] = [EMark.Dim, EMark.Bare, EMark.Rail, EMark.Accent]

export const SHIPPED_MARK = EMark.Dim

export type MarkPaint = { glyph: string; fg: string; text: string; note: string }

const LOUD: Record<EToolClass, boolean> = {
  [EToolClass.Gathered]: false,
  [EToolClass.Command]: false,
  [EToolClass.Change]: true,
  [EToolClass.External]: true,
  [EToolClass.Plan]: true,
}

const TONE: Record<EToolClass, string> = {
  [EToolClass.Gathered]: theme.accent,
  [EToolClass.Change]: theme.ok,
  [EToolClass.Command]: theme.accent,
  [EToolClass.External]: theme.court.external,
  [EToolClass.Plan]: theme.warn,
}

const BLANK = '  '

const GLYPHS: Record<EMark, string> = {
  [EMark.Accent]: '⏺ ',
  [EMark.Dim]: '⏺ ',
  [EMark.Bare]: BLANK,
  [EMark.Rail]: '╎ ',
}

export function markPaint(args: {
  style: EMark
  klass: EToolClass
  ok: boolean
  spinner?: string | undefined
  /**
   * Whether this row opens a cluster of tool rows, or continues one already running.
   *
   * Only the first row of a cluster keeps its glyph. A column of identical dots down a stretch of
   * twenty tool rows is not telling the reader anything the indentation has not already told them —
   * what they actually want to see is where the tools STOP and the prose starts again, and one mark
   * at the top of each cluster draws exactly that boundary.
   *
   * A loud row keeps its glyph wherever it falls, because that glyph is not saying "tool", it is
   * saying "this changed something" or "this went wrong", and those are not noise at any density.
   */
  opensCluster?: boolean | undefined
}): MarkPaint {
  const loud = args.style === EMark.Accent || LOUD[args.klass] || !args.ok
  const shows = loud || args.spinner !== undefined || args.opensCluster !== false

  return {
    glyph: args.spinner === undefined ? (shows ? GLYPHS[args.style] : BLANK) : `${args.spinner} `,
    fg: !args.ok ? theme.error : loud ? TONE[args.klass] : theme.rule,
    text: !args.ok ? theme.error : loud ? theme.hover : theme.meta,
    note: args.ok ? theme.rule : theme.error,
  }
}
