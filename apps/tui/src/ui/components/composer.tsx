import type { KeyBinding, KeyEvent } from '@opentui/core'
import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'

import { composerEdge, EComposerEdge } from '../composer-edge-store'
import { charRangeOf } from '../highlight-offsets'
import { mentionStyleId, mentionSyntaxStyle } from '../mention-style'
import { useAppearance } from '../hooks/use-appearance'
import type { DraftControls } from '../hooks/use-draft'
import { glyph, theme } from '../theme'
import { composerNoticeCells, composerTitle } from './composer-title'
import { EFrameRule, Frame, FRAME_INSET, FRAME_PAD } from './frame'
import { NoticeSlab } from './notice-slab'
import { Panel, PANEL_INSET, PANEL_PAD } from './panel'

const DEFAULT_MAX_ROWS = 8

export type HighlightSpan = { start: number; end: number }

const NOTHING_HIGHLIGHTED: readonly HighlightSpan[] = []

const spanKey = (spans: readonly HighlightSpan[]): string =>
  spans.map((span) => `${span.start}:${span.end}`).join(',')

export { composerTitle } from './composer-title'

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
 */
const ATLAS_BINDINGS: KeyBinding[] = [
  { name: 'return', shift: true, action: 'newline' },
  { name: 'return', ctrl: true, action: 'newline' },
  { name: 'return', meta: true, action: 'newline' },
]

const CHROME_COLUMNS = PANEL_INSET + PANEL_PAD

const FRAME_CHROME_COLUMNS = FRAME_INSET + FRAME_PAD + 1

const CARET_COLUMNS = 2

const CARET_CHROME_COLUMNS = CARET_COLUMNS + FRAME_PAD

const UNBOUNDED = 10_000

const overflowBadge = (hidden: number): string =>
  hidden === 1 ? '⋯ 1 more row' : `⋯ ${hidden} more rows`

const chromeColumns = (edge: EComposerEdge): number => {
  if (edge === EComposerEdge.Bordered) return FRAME_CHROME_COLUMNS
  if (edge === EComposerEdge.Claude) return CARET_CHROME_COLUMNS
  return CHROME_COLUMNS
}

function DerivedComposer(props: {
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
  useAppearance()
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

  /**
   * `super+backspace` is macOS's rub-out-the-line; ⌘ reaches a terminal application only under the
   * kitty keyboard protocol, which reports it as `super`, so a terminal that does not speak it
   * sends a bare `\x7f` and this never fires. OpenTUI's `delete-to-line-start` answers the key
   * against the logical line, which under `wrapMode="word"` is the whole paragraph, so the key is
   * handled here against the visual row instead: a selection goes whole, otherwise the row up to
   * the cursor, and at a row's start the one character before it.
   */
  const handleKeyDown = useCallback(
    (event: KeyEvent) => {
      if (event.name !== 'backspace' || event.super !== true) return
      const target = editor.current
      if (!target) return
      event.preventDefault()
      if (target.hasSelection()) {
        target.deleteSelection()
        return
      }
      const end = target.cursorOffset
      target.gotoVisualLineHome()
      const start = target.cursorOffset
      if (start < end) {
        target.setSelection(start, end)
        target.deleteSelection()
        return
      }
      if (end > 0) target.deleteCharBackward()
    },
    [editor],
  )

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

  const label = (bg: string): React.ReactNode => (
    <NoticeSlab bg={bg} cells={composerNoticeCells({ width: props.width, badge, title, edge })} />
  )

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
      onKeyDown={handleKeyDown}
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
        label={label(theme.appBg)}
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
      label={label(theme.panelBg)}
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

export const Composer = React.memo(DerivedComposer)
