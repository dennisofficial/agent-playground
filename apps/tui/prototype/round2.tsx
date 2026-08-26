// PROTOTYPE — throwaway. The round-2 surfaces that have no producer yet, drawn so they can be seen.
//
//   bun run proto:round2        (from the repo root)
//
// It must own a real terminal: `bun run --filter` and `turbo run` both pipe a script's output,
// which leaves stdin un-raw and sizes the renderer to a default rather than the window.
//
// Tab cycles the pages. Every component is the real one — only the data is invented.

import { createCliRenderer } from '@opentui/core'
import {
  collapseUnchanged,
  EEffort,
  MODEL_CATALOG,
  parseUnifiedDiff,
  sideBySideRows,
  type DiffFile,
} from '@dltech/atlas-core'
import { createRoot, useKeyboard, useTerminalDimensions } from '@opentui/react'
import React, { useState } from 'react'

import { InlineDiff } from '../src/ui/components/diff/inline-diff'
import { SideBySideDiff } from '../src/ui/components/diff/side-by-side-diff'
import { Footer } from '../src/ui/components/footer'
import { Sidebar } from '../src/ui/components/sidebar'
import { Switcher } from '../src/ui/components/switcher'
import { IDLE_TURN } from '../src/ui/components/transcript'
import { registerGrammars } from '../src/ui/markdown/grammars/index'
import { openSwitcher } from '../src/ui/switcher-model'
import { theme, SIDEBAR_WIDTH } from '../src/ui/theme'
import { FED_SIDEBAR, PATCH } from './round2-data'

const PAGES = ['sidebar', 'inline diff', 'side-by-side', 'switcher'] as const

type Page = (typeof PAGES)[number]

const CONTEXT = 1

const collapsedOf = (file: DiffFile): DiffFile => ({
  ...file,
  hunks: file.hunks.map((hunk) => collapseUnchanged({ hunk, context: CONTEXT })),
})

function Bar(props: { page: Page; width: number }): React.ReactNode {
  return (
    <box flexDirection="row" flexShrink={0} backgroundColor={theme.panelBg} paddingLeft={2}>
      <text fg={theme.accent}>⏺ </text>
      <text fg={theme.hover}>{props.page}</text>
      <box flexGrow={1} />
      <text fg={theme.hint}>{`⇥ next · ctrl+c quit · ${props.width} cols  `}</text>
    </box>
  )
}

function Page(props: { page: Page; width: number }): React.ReactNode {
  const [file] = parseUnifiedDiff(PATCH)
  if (file === undefined) return <text fg={theme.error}>the fixture patch did not parse</text>

  if (props.page === 'sidebar') {
    return (
      <Sidebar
        width={SIDEBAR_WIDTH}
        model={FED_SIDEBAR}
        turn={IDLE_TURN}
        now={0}
        cwd={process.cwd()}
      />
    )
  }

  if (props.page === 'inline diff') {
    return (
      <InlineDiff
        file={collapsedOf(file)}
        width={props.width}
        files={{ index: 1, total: 3 }}
      />
    )
  }

  if (props.page === 'side-by-side') {
    return (
      <SideBySideDiff
        file={file}
        rows={collapsedOf(file).hunks.map((hunk) => sideBySideRows(hunk))}
        width={props.width}
      />
    )
  }

  return (
    <Switcher
      width={Math.min(56, props.width)}
      models={MODEL_CATALOG}
      state={openSwitcher({
        models: MODEL_CATALOG,
        activeModelId: 'claude-haiku-4-5',
        effort: EEffort.Medium,
      })}
      activeModelId="claude-haiku-4-5"
      availability={(id) => id.startsWith('claude')}
      onPick={() => undefined}
      onDismiss={() => undefined}
    />
  )
}

function Round2(): React.ReactNode {
  const { width } = useTerminalDimensions()
  const [index, setIndex] = useState(0)
  const page = PAGES[index % PAGES.length] ?? PAGES[0]

  useKeyboard((key) => {
    if (key.eventType === 'release') return
    if (key.name === 'tab') setIndex((current) => current + 1)
  })

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0}>
      <Bar page={page} width={width} />
      <box flexDirection="row" flexGrow={1} flexShrink={1} flexBasis={0} paddingTop={1}>
        <Page page={page} width={width} />
      </box>
      <Footer
        width={width}
        model="haiku-4-5"
        effort={EEffort.Medium}
        context={{ percent: 62, tokensLeft: 124_000 }}
      />
    </box>
  )
}

const PIPED = 1

if (import.meta.main) {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write(
      'This prototype needs a real terminal. Run `bun run proto:round2` from the repo root — ' +
        'not through `bun run --filter` or `turbo run`, which pipe the output.\n',
    )
    process.exit(PIPED)
  }

  await registerGrammars()

  const renderer = await createCliRenderer({ useMouse: true, exitOnCtrlC: false, targetFps: 120 })
  renderer.on('destroy', () => process.exit(0))

  createRoot(renderer).render(<Round2 />)
}
