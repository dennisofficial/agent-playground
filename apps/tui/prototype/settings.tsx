// PROTOTYPE — throwaway. Not shipped, not imported by src/. Pick a direction, fold it in, delete it.
//
//   bun run proto:settings     (from the repo root)
//
// The question: does a preview docked under the settings list earn its rows?
//
// It is bordered and sits on its own ground so it reads as a window onto the app rather than as
// more list. Each previewable setting brings its own scene — the composer edge draws a composer,
// block padding draws a fence and a diff, the accent draws the marks that carry it. Settings that
// change nothing visual, and settings that are already visible while you change them, bring none.

import { createCliRenderer } from '@opentui/core'
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react'
import React, { useEffect, useState, useSyncExternalStore } from 'react'

import { applyAppearance, type Appearance } from '../src/ui/appearance'
import { SHIPPED_IMAGE_ROWS } from '../src/ui/image-rows-store'
import {
  subscribeComposerEdge,
  composerEdgeVersion,
  EComposerEdge,
} from '../src/ui/composer-edge-store'
import { subscribeDensity, densityVersion, EBlockDensity } from '../src/ui/density-store'
import { subscribePalette, paletteVersion } from '../src/ui/palette-store'
import { registerGrammars } from '../src/ui/markdown/grammars/index'
import { theme } from '../src/ui/theme'
import { previewFor } from './settings-previews'

type Row = {
  id: string
  label: string
  group: string
  options: readonly string[]
}

const ROWS: readonly Row[] = [
  { id: 'accent', label: 'Accent', group: 'Colour', options: ['clay', 'slate', 'moss', 'plum'] },
  { id: 'density', label: 'Block padding', group: 'Density', options: ['comfort', 'compact'] },
  { id: 'composer', label: 'Composer edge', group: 'Composer', options: ['slab', 'bordered', 'claude'] },
  { id: 'thinking', label: 'Thinking blocks', group: 'Transcript', options: ['keep', 'while streaming', 'hide'] },
  { id: 'sidebar', label: 'Sidebar width', group: 'Layout', options: ['38 cols', '42 cols', '46 cols'] },
]

type Held = Record<string, string>

const SHIPPED: Held = {
  accent: 'clay',
  density: 'comfort',
  composer: 'slab',
  thinking: 'keep',
  sidebar: '42 cols',
}

const appearanceOf = (held: Held): Appearance => ({
  accent: held.accent ?? 'clay',
  density: held.density === 'compact' ? EBlockDensity.Compact : EBlockDensity.Comfort,
  composer:
    held.composer === 'bordered'
      ? EComposerEdge.Bordered
      : held.composer === 'claude'
        ? EComposerEdge.Claude
        : EComposerEdge.Slab,
  imageRows: SHIPPED_IMAGE_ROWS,
})

const BAND_MARGIN = 2

const BAND_BORDER = 1

const BAND_PAD = 2

const BAND_CHROME = (BAND_MARGIN + BAND_BORDER + BAND_PAD) * 2

const stepped = (args: { options: readonly string[]; value: string; delta: number }): string => {
  const at = args.options.indexOf(args.value)
  const next = (at + args.delta + args.options.length) % args.options.length
  return args.options[next] ?? args.value
}

function Bar(props: { width: number }): React.ReactNode {
  return (
    <box
      flexDirection="column"
      width={props.width}
      flexShrink={0}
      backgroundColor={theme.overlayBg}
      paddingLeft={1}
      paddingRight={1}
    >
      <text>
        <span fg={theme.accent}>{'PROTOTYPE  '}</span>
        <span fg={theme.hover}>settings preview</span>
        <span fg={theme.hint}>{'  a bordered band, one scene per setting'}</span>
      </text>
      <text>
        <span fg={theme.meta}>↑↓</span>
        <span fg={theme.hint}> row · </span>
        <span fg={theme.meta}>←→ ⏎</span>
        <span fg={theme.hint}> value · </span>
        <span fg={theme.meta}>ctrl+c</span>
        <span fg={theme.hint}> quit</span>
      </text>
    </box>
  )
}

function List(props: { held: Held; at: number }): React.ReactNode {
  let group = ''

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      flexBasis={0}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
    >
      {ROWS.map((row, index) => {
        const heading = row.group === group ? null : row.group
        group = row.group
        const on = index === props.at

        return (
          <box key={row.id} flexDirection="column" flexShrink={0}>
            {heading === null ? null : <text fg={theme.meta}>{`\n${heading.toUpperCase()}`}</text>}
            <box
              flexDirection="row"
              flexShrink={0}
              backgroundColor={on ? theme.hoverBg : theme.appBg}
            >
              <text fg={on ? theme.accent : theme.dim}>{on ? ' ❯ ' : '   '}</text>
              <text fg={on ? theme.bright : theme.body} flexGrow={1}>
                {row.label}
              </text>
              <text fg={theme.meta}>{props.held[row.id] ?? ''}</text>
              <text fg={theme.dim}>{previewFor(row.id) === undefined ? '   ' : '  ◱'}</text>
            </box>
          </box>
        )
      })}
    </box>
  )
}

function Band(props: { width: number; row: Row; held: Held }): React.ReactNode {
  const preview = previewFor(props.row.id)
  if (preview === undefined) return null

  const inner = props.width - BAND_CHROME

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      marginLeft={BAND_MARGIN}
      marginRight={BAND_MARGIN}
      paddingLeft={BAND_PAD}
      paddingRight={BAND_PAD}
      backgroundColor={theme.panelBg}
      border
      borderColor={theme.rule}
    >
      <box flexDirection="row" flexShrink={0}>
        <text fg={theme.meta} flexGrow={1}>
          {props.row.label.toUpperCase()}
        </text>
        <text fg={theme.hint}>{props.held[props.row.id] ?? ''}</text>
      </box>
      {preview.render({ width: inner, appearance: appearanceOf(props.held) })}
    </box>
  )
}

export function SettingsPrototype(): React.ReactNode {
  const renderer = useRenderer()
  const { width } = useTerminalDimensions()

  useSyncExternalStore(subscribePalette, paletteVersion)
  useSyncExternalStore(subscribeDensity, densityVersion)
  useSyncExternalStore(subscribeComposerEdge, composerEdgeVersion)

  const [held, setHeld] = useState<Held>(SHIPPED)
  const [at, setAt] = useState(0)

  const row = ROWS[at] ?? (ROWS[0] as Row)

  useEffect(() => {
    applyAppearance(appearanceOf(held))
  }, [held])

  const cycle = (delta: number): void => {
    setHeld((current) => ({
      ...current,
      [row.id]: stepped({ options: row.options, value: current[row.id] ?? '', delta }),
    }))
  }

  useKeyboard((key) => {
    if (key.eventType === 'release') return

    if (key.ctrl && key.name === 'c') {
      key.preventDefault()
      renderer.destroy()
      return
    }
    if (key.name === 'up' || key.name === 'down') {
      key.preventDefault()
      setAt((current) => Math.min(Math.max(0, current + (key.name === 'up' ? -1 : 1)), ROWS.length - 1))
      return
    }
    if (key.name === 'left' || key.name === 'right' || key.name === 'return') {
      key.preventDefault()
      cycle(key.name === 'left' ? -1 : 1)
    }
  })

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      flexBasis={0}
      backgroundColor={theme.appBg}
    >
      <Bar width={width} />
      <List held={held} at={at} />
      <Band width={width} row={row} held={held} />
      <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
        <text fg={theme.hint}>edits write to ~/.atlas/settings.json</text>
      </box>
    </box>
  )
}

const PIPED = 1

if (import.meta.main) {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write(
      'This prototype needs a real terminal. Run `bun run proto:settings` from the repo root.\n',
    )
    process.exit(PIPED)
  }

  await registerGrammars()

  const renderer = await createCliRenderer({ useMouse: true, exitOnCtrlC: false, targetFps: 120 })
  renderer.on('destroy', () => process.exit(0))

  createRoot(renderer).render(<SettingsPrototype />)
}
