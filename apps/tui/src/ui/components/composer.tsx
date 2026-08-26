import type { KeyBinding } from '@opentui/core'
import React, { useCallback, useLayoutEffect, useState } from 'react'

import type { DraftControls } from '../hooks/use-draft'
import { theme } from '../theme'
import { Panel, PANEL_INSET, PANEL_PAD } from './panel'

const DEFAULT_MAX_ROWS = 8

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

const railColour = (tone: EComposerTone): string =>
  tone === EComposerTone.Interrupting ? theme.warn : theme.accent

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

const UNBOUNDED = 10_000

const overflowBadge = (hidden: number): string =>
  hidden === 1 ? '⋯ 1 more row' : `⋯ ${hidden} more rows`

export function Composer(props: {
  draft: DraftControls
  width: number
  tone?: EComposerTone
  placeholder?: string
  maxRows?: number
  focused?: boolean
}): React.ReactNode {
  const tone = props.tone ?? EComposerTone.Idle
  const maxRows = props.maxRows ?? DEFAULT_MAX_ROWS
  const [metrics, setMetrics] = useState({ rows: 1, total: 1 })

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
      Math.max(8, props.width - CHROME_COLUMNS),
      UNBOUNDED,
    )
    const total = Math.max(1, measured?.lineCount ?? 1)
    const rows = Math.min(total, maxRows)
    setMetrics((current) =>
      current.rows === rows && current.total === total ? current : { rows, total },
    )
  }, [editor, maxRows, props.width])

  useLayoutEffect(() => {
    const target = editor.current
    if (!target) return
    target.cursorOffset = target.plainText.length
    measure()
  }, [editor, measure])

  const handleChange = useCallback(() => {
    const target = editor.current
    if (!target) return
    sync(target.plainText)
    measure()
  }, [editor, measure, sync])

  const hidden = metrics.total - metrics.rows

  return (
    <Panel
      width={props.width}
      rail={railColour(tone)}
      fill={theme.panelBg}
      {...(hidden > 0
        ? {
            badge: (
              <text fg={theme.hint} bg={theme.panelBg}>{` ${overflowBadge(hidden)} `}</text>
            ),
          }
        : {})}
    >
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
        onCursorChange={measure}
      />
    </Panel>
  )
}
