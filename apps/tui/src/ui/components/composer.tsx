import type { KeyBinding } from '@opentui/core'
import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'

import { composerEdge, EComposerEdge } from '../composer-edge-store'
import { charRangeOf } from '../highlight-offsets'
import { mentionStyleId, mentionSyntaxStyle } from '../mention-style'
import type { DraftControls } from '../hooks/use-draft'
import { cellsOf } from '../hint-layout'
import { glyph, theme } from '../theme'
import { EFrameRule, Frame, FRAME_INSET, FRAME_PAD } from './frame'
import { NoticeSlab } from './notice-slab'
import { Panel, PANEL_INSET, PANEL_PAD } from './panel'
import { truncateCells } from './sidebar/cells'

const DEFAULT_MAX_ROWS = 8

export type HighlightSpan = { start: number; end: number }

const NOTHING_HIGHLIGHTED: readonly HighlightSpan[] = []

const spanKey = (spans: readonly HighlightSpan[]): string =>
  spans.map((span) => `${span.start}:${span.end}`).join(',')

export function composerRows(height: number): number {
  return Math.max(DEFAULT_MAX_ROWS, Math.floor(height / 2) - 2)
}

export enum EComposerTone {
  Idle = 'idle',
  Working = 'working',
  Interrupting = 'interrupting',
}

export function composerTone(args: { working: boolean; interrupting: boolean }): EComposerTone {
  if (args.interrupting) return EComposerTone.Interrupting
  if (args.working) return EComposerTone.Working
  return EComposerTone.Idle
}

const railColour = (tone: EComposerTone, accent: string): string =>
  tone === EComposerTone.Interrupting ? theme.warn : accent

/**
 * What Atlas adds to OpenTUI's own keymap. Bindings are looked up by an exact
 * `name:ctrl:shift:meta:super` key, so a default binding on the bare key does not answer a modified
 * one: unbound, `shift+⏎` falls through to the printable path where `\r` is dropped. `meta+⏎` is
 * remapped off its default `submit` because the page owns submit, on a plain `⏎`.
 *
 * `super+backspace` is macOS's rub-out-the-line, and ⌘ reaches a terminal application only under
 * the kitty keyboard protocol, which reports it as `super`. A terminal that does not speak it sends
 * a bare `\x7f` and gets the ordinary backspace.
 */
const ATLAS_BINDINGS: KeyBinding[] = [
  { name: 'return', shift: true, action: 'newline' },
  { name: 'return', ctrl: true, action: 'newline' },
  { name: 'return', meta: true, action: 'newline' },
  { name: 'backspace', super: true, action: 'delete-to-line-start' },
]

const CHROME_COLUMNS = PANEL_INSET + PANEL_PAD

const FRAME_CHROME_COLUMNS = FRAME_INSET + FRAME_PAD + 1

const CARET_COLUMNS = 2

const CARET_CHROME_COLUMNS = CARET_COLUMNS + FRAME_PAD

const UNBOUNDED = 10_000

const overflowBadge = (hidden: number): string =>
  hidden === 1 ? '⋯ 1 more row' : `⋯ ${hidden} more rows`

const TITLE_PAD = 1

const TITLE_MIN_CELLS = 8

const RAIL_COLUMNS = 1

const CLOSING_RULE_COLUMNS = 1

const chromeColumns = (edge: EComposerEdge): number => {
  if (edge === EComposerEdge.Bordered) return FRAME_CHROME_COLUMNS
  if (edge === EComposerEdge.Claude) return CARET_CHROME_COLUMNS
  return CHROME_COLUMNS
}

const TITLE_RUNWAY = 4

const NOTICE_RUNWAY = 2

const slabCells = (text: string): number => cellsOf(text) + TITLE_PAD * 2

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

export function Composer(props: {
  draft: DraftControls
  width: number
  tone?: EComposerTone
  placeholder?: string
  maxRows?: number
  focused?: boolean
  title?: string
  accent?: string
  highlights?: readonly HighlightSpan[]
  onCursorMoved?: (() => void) | undefined
}): React.ReactNode {
  const tone = props.tone ?? EComposerTone.Idle
  const rail = railColour(tone, props.accent ?? theme.accent)
  const edge = composerEdge()
  const maxRows = props.maxRows ?? DEFAULT_MAX_ROWS
  const [metrics, setMetrics] = useState({ rows: 1, total: 1 })

  const chrome = chromeColumns(edge)

  const editor = props.draft.editor
  const sync = props.draft.sync

  /**
   * A renderable takes a height and keeps it, so the box is grown to the draft against a width we
   * compute ourselves: `virtualLineCount` reports the viewport's wrapped lines, which pegs the box
   * at whatever it already was, and `getTotalVirtualLineCount()` answers for the width yoga has
   * already applied — which, on the pass that decides the first frame, is not yet the real one.
   */
  const measure = useCallback(() => {
    const target = editor.current
    if (!target) return
    const measured = target.editorView.measureForDimensions(
      Math.max(8, props.width - chrome),
      UNBOUNDED,
    )
    const total = Math.max(1, measured?.lineCount ?? 1)
    const rows = Math.min(total, maxRows)
    setMetrics((current) =>
      current.rows === rows && current.total === total ? current : { rows, total },
    )
  }, [chrome, editor, maxRows, props.width])

  useLayoutEffect(() => {
    const target = editor.current
    if (!target) return
    target.cursorOffset = target.plainText.length
    measure()
  }, [editor, measure])

  /**
   * Highlights are held by the native edit buffer, not by React, so they are repainted whole on
   * every edit rather than diffed. Repainting only when the spans change is not enough: the buffer
   * grows a highlight to cover text inserted against its end, so a mention would swallow whatever
   * was typed after it. Observed against @opentui/core 0.4.5.
   */
  const highlights = props.highlights ?? NOTHING_HIGHLIGHTED
  const painted = useRef(highlights)
  painted.current = highlights
  const highlightKey = spanKey(highlights)
  const drafted = props.draft.value

  useLayoutEffect(() => {
    const target = editor.current
    if (!target) return

    const style = mentionSyntaxStyle()
    if (target.syntaxStyle !== style) target.syntaxStyle = style

    target.clearAllHighlights()

    const styleId = mentionStyleId()
    if (styleId === null) return

    const text = target.plainText
    for (const span of painted.current) {
      const range = charRangeOf({ text, span })
      target.addHighlightByCharRange({ start: range.start, end: range.end, styleId })
    }
  }, [drafted, editor, highlightKey])

  const handleCursorMoved = props.onCursorMoved

  const handleCursorChange = useCallback(() => {
    measure()
    handleCursorMoved?.()
  }, [handleCursorMoved, measure])

  const handleChange = useCallback(() => {
    const target = editor.current
    if (!target) return
    sync(target.plainText)
    measure()
  }, [editor, measure, sync])

  const hidden = metrics.total - metrics.rows
  const badge = hidden > 0 ? overflowBadge(hidden) : null
  const title =
    props.title === undefined
      ? null
      : composerTitle({ title: props.title, width: props.width, badge, edge })

  const noticeCells = composerNoticeCells({ width: props.width, badge, title, edge })

  const draft = (
    <textarea
      ref={editor}
      initialValue={props.draft.initial}
      focused={props.focused !== false}
      flexGrow={1}
      wrapMode="word"
      height={metrics.rows}
      textColor={theme.userFg}
      cursorColor={theme.caretBg}
      keyBindings={ATLAS_BINDINGS}
      {...(props.placeholder === undefined ? {} : { placeholder: props.placeholder })}
      placeholderColor={theme.hint}
      onContentChange={handleChange}
      onCursorChange={handleCursorChange}
    />
  )

  if (edge === EComposerEdge.Bordered || edge === EComposerEdge.Claude) {
    return (
      <Frame
        width={props.width}
        colour={rail}
        {...(edge === EComposerEdge.Claude
          ? {
              rule: EFrameRule.Open,
              lead: (
                <box width={CARET_COLUMNS} flexShrink={0}>
                  <text fg={rail}>{glyph.user}</text>
                </box>
              ),
            }
          : {})}
        label={<NoticeSlab bg={theme.appBg} cells={noticeCells} />}
        {...(badge === null
          ? {}
          : { badge: <text fg={theme.hint} bg={theme.appBg}>{` ${badge} `}</text> })}
        {...(title === null
          ? {}
          : {
              title: <text fg={theme.caretFg} bg={rail}>{` ${title} `}</text>,
            })}
      >
        {draft}
      </Frame>
    )
  }

  return (
    <Panel
      width={props.width}
      rail={rail}
      fill={theme.panelBg}
      label={<NoticeSlab bg={theme.panelBg} cells={noticeCells} />}
      {...(badge === null
        ? {}
        : { badge: <text fg={theme.hint} bg={theme.panelBg}>{` ${badge} `}</text> })}
      {...(title === null
        ? {}
        : { title: <text fg={theme.body} bg={theme.panelBg}>{` ${title} `}</text> })}
    >
      {draft}
    </Panel>
  )
}
