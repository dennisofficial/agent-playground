// PROTOTYPE — throwaway. Terminal focus reporting: when do the renderer's focus/blur events
// fire, and what does a greyed-out accent feel like on an unfocused window?
//
// The accent-spending samples below ride the real palette: blur applies a grey palette through
// `applyPalette`, focus restores the clay one, and the root repaints via the same
// `useSyncExternalStore(subscribePalette, paletteVersion)` the app uses. The log records every
// event with a timestamp so the trigger pattern is visible — tab away, click another window,
// ⌘-Tab back, and watch what actually arrives.
//
//   bun run proto:focus        (from the repo root)
//
// It must own a real terminal: `bun run --filter` and `turbo run` both pipe a script's output,
// which leaves stdin un-raw and sizes the renderer to a default rather than the window.

import { CliRenderEvents, createCliRenderer } from '@opentui/core'
import { createRoot, useKeyboard, useRenderer } from '@opentui/react'
import React, { useEffect, useState, useSyncExternalStore } from 'react'

import { accentPalette } from '../src/ui/accents'
import { SHIPPED_ACCENT } from '../src/ui/appearance'
import { SHIPPED_PALETTE, theme, type Palette } from '../src/ui/palette'
import { applyPalette, paletteVersion, subscribePalette } from '../src/ui/palette-store'

function greyPalette(): Partial<Palette> {
  const grey = theme.dim
  return {
    accent: grey,
    caretBg: grey,
    codeInline: grey,
    court: { ...SHIPPED_PALETTE.court, agent: grey, yours: grey },
  }
}

const stamp = (): string => new Date().toISOString().slice(11, 23)

type SequenceListener = (sequence: string) => void

const sequenceListeners = new Set<SequenceListener>()

const interesting = (sequence: string): boolean =>
  sequence.includes('1004') || sequence === '\x1b[I' || sequence === '\x1b[O'

function FocusProbe(): React.ReactNode {
  const renderer = useRenderer()
  useSyncExternalStore(subscribePalette, paletteVersion)

  const [state, setState] = useState<string>('no event yet — assumed focused')
  const [log, setLog] = useState<readonly string[]>([])

  useEffect(() => {
    const note = (line: string): void => setLog((current) => [...current.slice(-9), `${stamp()}  ${line}`])

    const sniff = (sequence: string): void => note(`stdin ${JSON.stringify(sequence)}`)
    sequenceListeners.add(sniff)

    const onFocus = (): void => {
      applyPalette(accentPalette(SHIPPED_ACCENT))
      setState('FOCUSED — accent restored')
      note('focus — palette back to clay')
    }
    const onBlur = (): void => {
      applyPalette(greyPalette())
      setState('BLURRED — accent greyed')
      note('blur  — palette greyed')
    }

    renderer.on(CliRenderEvents.FOCUS, onFocus)
    renderer.on(CliRenderEvents.BLUR, onBlur)
    return () => {
      sequenceListeners.delete(sniff)
      renderer.off(CliRenderEvents.FOCUS, onFocus)
      renderer.off(CliRenderEvents.BLUR, onBlur)
    }
  }, [renderer])

  useKeyboard((key) => {
    if (key.eventType === 'release') return
    if (key.ctrl === true && key.name === 'c') process.exit(0)
  })

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} paddingLeft={2} paddingTop={1} gap={1}>
      <text fg={theme.rule}>switch windows and watch the accent — ctrl+c quit</text>
      <text fg={theme.hint}>
        {`${process.env.TERM_PROGRAM ?? 'unknown terminal'} · TERM=${process.env.TERM ?? '?'}${process.env.TMUX ? ' · inside tmux' : ''}`}
      </text>

      <box flexDirection="column" flexShrink={0}>
        <text fg={theme.accent}>## a heading spends the accent</text>
        <text>
          <span fg={theme.accent}>❯ </span>
          <span fg={theme.body}>a selected row leads with it</span>
        </text>
        <text fg={theme.codeInline}>inline code tinted with it</text>
        <text>
          <span bg={theme.caretBg} fg={theme.caretFg}> </span>
          <span fg={theme.body}> the caret block</span>
        </text>
      </box>

      <text fg={theme.hover}>{state}</text>

      <box flexDirection="column" flexShrink={0}>
        <text fg={theme.rule}>event log</text>
        {log.length === 0 ? <text fg={theme.hint}>nothing yet</text> : null}
        {log.map((line) => (
          <text key={line} fg={theme.hint}>
            {line}
          </text>
        ))}
      </box>
    </box>
  )
}

const PIPED = 1

if (import.meta.main) {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write(
      'This prototype needs a real terminal. Run `bun run proto:focus` from the repo root — ' +
        'not through `bun run --filter` or `turbo run`, which pipe the output.\n',
    )
    process.exit(PIPED)
  }

  const renderer = await createCliRenderer({
    useMouse: true,
    exitOnCtrlC: false,
    targetFps: 120,
    prependInputHandlers: [
      (sequence) => {
        if (!interesting(sequence)) return false
        for (const listener of sequenceListeners) listener(sequence)
        return false
      },
    ],
  })

  // https://github.com/anomalyco/opentui/issues/1333 — opentui gates mode 1004 on a DECRQM
  // answer and never enables it on terminals that stay quiet, so enable it ourselves. The
  // parser dispatches FOCUS/BLUR whether or not the renderer set the mode.
  process.stdout.write('\x1b[?1004h')
  process.on('exit', () => process.stdout.write('\x1b[?1004l'))

  renderer.on('destroy', () => {
    process.stdout.write('\x1b[?1004l')
    process.exit(0)
  })

  createRoot(renderer).render(<FocusProbe />)
}
