// PROTOTYPE — throwaway. The redesigned footer pills: filled chips a single space apart, no
// separator dots.
//
//   gallery  Every pill and state, drawn by the real builders — `pullRequestItem`, `shellsItem`,
//            `subagentsItem` — stacked so the matrix is visible at once. The services chip is a
//            preview only: the services registry is still uncommitted work in another session,
//            so its colour and count here are invented.
//   live     One footer you can drive: ↓ enters the band, ←/→ walk it, ⏎ fires the pill, esc
//            leaves. Pointer clicks and hovers behave as they do in the app.
//   sidebar  Where shells and subagents live in full — the footer only carries their counts.
//
//   bun run proto:footer        (from the repo root)
//
// It must own a real terminal: `bun run --filter` and `turbo run` both pipe a script's output,
// which leaves stdin un-raw and sizes the renderer to a default rather than the window.

import { createCliRenderer } from '@opentui/core'
import { EEffort } from '@dltech/atlas-core'
import { EShellStatus, toShellId, type ShellSnapshot } from '@dltech/atlas-harness'
import { createRoot, useKeyboard, useTerminalDimensions } from '@opentui/react'
import React, { useState } from 'react'

import { subagentsItem } from '../src/composition/agents-surface'
import { shellsItem } from '../src/composition/shells-surface'
import { plural } from '../src/store/tools/reading'
import { pullRequestItem } from '../src/plugins/github/surface'
import { EChecksState, EPullRequestState, type PullRequestBadge } from '../src/plugins/github/pure'
import { Footer } from '../src/ui/components/footer'
import { Sidebar } from '../src/ui/components/sidebar'
import { IDLE_TURN } from '../src/ui/components/transcript'
import { chipItem, EFooterItemReach, type FooterItem } from '../src/ui/footer-item'
import { enterStrip, moveStripSelection, type FooterStripState } from '../src/ui/footer-strip'
import { registerGrammars } from '../src/ui/markdown/grammars/index'
import { SIDEBAR_WIDTH, theme } from '../src/ui/theme'
import { FED_SIDEBAR } from './round2-data'

const PAGES = ['gallery', 'live', 'sidebar'] as const

type Page = (typeof PAGES)[number]

const noop = (): void => undefined

const badge = (args: { pr: number; state: EPullRequestState; checks: EChecksState }): PullRequestBadge => ({
  label: `#${args.pr}`,
  url: 'https://example.invalid/pull/0',
  state: args.state,
  checks: args.checks,
})

const pr = (args: { pr: number; state: EPullRequestState; checks: EChecksState }): FooterItem =>
  pullRequestItem({ badge: badge(args), onOpen: noop }) as FooterItem

const shells = (running: number): FooterItem => shellsItem({ running, onOpen: noop }) as FooterItem

const subagents = (running: number): FooterItem =>
  subagentsItem({ running, onOpen: noop }) as FooterItem

const services = (running: number): FooterItem =>
  chipItem({
    id: 'services',
    text: plural(running, 'service'),
    ground: '#79c0ff',
    reach: EFooterItemReach.Keyboard,
    onActivate: noop,
  })

const SETTLED = EChecksState.None

type GalleryRow = {
  label: string
  items: readonly FooterItem[]
  model?: string
  effort?: EEffort
  strip?: FooterStripState
}

const GALLERY: readonly GalleryRow[] = [
  {
    label: 'open · checks passing',
    items: [pr({ pr: 412, state: EPullRequestState.Open, checks: EChecksState.Passing })],
  },
  {
    label: 'open · checks failing — the screenshot, with the readout it sat beside',
    model: 'kimi-k3-fast',
    effort: EEffort.High,
    items: [pr({ pr: 349, state: EPullRequestState.Open, checks: EChecksState.Failing })],
  },
  {
    label: 'open · checks running',
    items: [pr({ pr: 128, state: EPullRequestState.Open, checks: EChecksState.Running })],
  },
  {
    label: 'open · no checks configured',
    items: [pr({ pr: 64, state: EPullRequestState.Open, checks: SETTLED })],
  },
  {
    label: 'draft',
    items: [pr({ pr: 77, state: EPullRequestState.Draft, checks: SETTLED })],
  },
  {
    label: 'merged — settled states drop the check mark',
    items: [pr({ pr: 301, state: EPullRequestState.Merged, checks: SETTLED })],
  },
  {
    label: 'closed',
    items: [pr({ pr: 96, state: EPullRequestState.Closed, checks: SETTLED })],
  },
  {
    label: 'shells running — idle shells draw no pill at all',
    items: [shells(2)],
  },
  {
    label: 'subagents running — same rule',
    items: [subagents(1)],
  },
  {
    label: 'services — preview, the registry has not landed on main',
    items: [services(1)],
  },
  {
    label: 'the full row, the band resting on subagents',
    items: [
      pr({ pr: 349, state: EPullRequestState.Open, checks: EChecksState.Failing }),
      shells(2),
      subagents(1),
      services(1),
    ],
    strip: { itemId: 'subagents' },
  },
]

function GalleryRowView(props: { row: GalleryRow; width: number }): React.ReactNode {
  return (
    <box flexDirection="column" flexShrink={0}>
      <box paddingLeft={2}>
        <text fg={theme.rule}>{props.row.label}</text>
      </box>
      <Footer
        width={props.width}
        model={props.row.model ?? 'haiku-4-5'}
        effort={props.row.effort ?? EEffort.Medium}
        items={props.row.items}
        strip={props.row.strip ?? null}
        context={{ percent: 62, tokensUsed: 124_000 }}
        onActivateItem={noop}
      />
    </box>
  )
}

function Gallery(props: { width: number }): React.ReactNode {
  return (
    <box flexDirection="column" flexShrink={0} gap={1} paddingTop={1}>
      {GALLERY.map((row) => (
        <GalleryRowView key={row.label} row={row} width={props.width} />
      ))}
    </box>
  )
}

const LIVE_ITEMS: readonly FooterItem[] = [
  pr({ pr: 349, state: EPullRequestState.Open, checks: EChecksState.Failing }),
  shells(2),
  subagents(1),
  services(1),
]

function Live(props: { width: number }): React.ReactNode {
  const [strip, setStrip] = useState<FooterStripState | null>(null)
  const [fired, setFired] = useState<string>('nothing fired yet')

  useKeyboard((key) => {
    if (key.eventType === 'release') return

    if (strip === null) {
      if (key.name === 'down') setStrip(enterStrip(LIVE_ITEMS))
      return
    }

    if (key.name === 'left') setStrip(moveStripSelection({ state: strip, items: LIVE_ITEMS, delta: -1 }))
    if (key.name === 'right') setStrip(moveStripSelection({ state: strip, items: LIVE_ITEMS, delta: 1 }))
    if (key.name === 'escape' || key.name === 'up') setStrip(null)
    if (key.name === 'return') setFired(`enter fired ${strip.itemId}`)
  })

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0}>
      <box flexDirection="column" paddingLeft={2} paddingTop={1} gap={0}>
        <text fg={theme.rule}>↓ takes the band · ←/→ walk it · ⏎ fires · esc drops it · clicks work too</text>
        <text fg={theme.hint}>{fired}</text>
      </box>
      <box flexGrow={1} />
      <Footer
        width={props.width}
        model="haiku-4-5"
        effort={EEffort.Medium}
        items={LIVE_ITEMS}
        strip={strip}
        context={{ percent: 62, tokensUsed: 124_000 }}
        onActivateItem={(item) => setFired(`click fired ${item.id}`)}
      />
    </box>
  )
}

const THEN = '2026-01-01T00:10:00.000Z'
const NOW = Date.parse(THEN)

const minutesAgo = (minutes: number): string =>
  new Date(NOW - minutes * 60_000).toISOString()

const SIDEBAR_SHELLS: readonly ShellSnapshot[] = [
  {
    shellId: toShellId('sh-dev'),
    command: 'bun run dev',
    description: 'dev server',
    status: EShellStatus.Running,
    pid: 0,
    startedAt: minutesAgo(9),
    lastOutputAt: minutesAgo(1),
    totalCharacters: 0,
    awaitingInput: false,
  },
  {
    shellId: toShellId('sh-tests'),
    command: 'bun test --watch',
    description: 'watch the tests',
    status: EShellStatus.Running,
    pid: 0,
    startedAt: minutesAgo(4),
    lastOutputAt: minutesAgo(2),
    totalCharacters: 0,
    awaitingInput: true,
  },
  {
    shellId: toShellId('sh-fetch'),
    command: 'git fetch origin',
    description: 'fetch origin',
    status: EShellStatus.Exited,
    exitCode: 0,
    pid: 0,
    startedAt: minutesAgo(21),
    lastOutputAt: minutesAgo(20),
    endedAt: minutesAgo(20),
    totalCharacters: 0,
    awaitingInput: false,
  },
]

function SidebarPage(): React.ReactNode {
  return (
    <box flexDirection="row" flexGrow={1} flexShrink={1} flexBasis={0}>
      <box flexGrow={1} paddingLeft={2} paddingTop={1}>
        <text fg={theme.rule}>the full shells and subagents sections — the footer only carries counts</text>
      </box>
      <Sidebar
        width={SIDEBAR_WIDTH}
        model={FED_SIDEBAR}
        turn={IDLE_TURN}
        now={NOW}
        root={process.cwd()}
        worktree={null}
        shells={SIDEBAR_SHELLS}
        shellNow={NOW}
      />
    </box>
  )
}

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

function FooterPills(): React.ReactNode {
  const { width } = useTerminalDimensions()
  const [index, setIndex] = useState(0)
  const page = PAGES[index % PAGES.length] ?? PAGES[0]

  useKeyboard((key) => {
    if (key.eventType === 'release') return
    if (key.ctrl === true && key.name === 'c') process.exit(0)
    if (key.name === 'tab') setIndex((current) => current + 1)
  })

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0}>
      <Bar page={page} width={width} />
      {page === 'gallery' ? <Gallery width={width} /> : null}
      {page === 'live' ? <Live width={width} /> : null}
      {page === 'sidebar' ? <SidebarPage /> : null}
    </box>
  )
}

const PIPED = 1

if (import.meta.main) {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write(
      'This prototype needs a real terminal. Run `bun run proto:footer` from the repo root — ' +
        'not through `bun run --filter` or `turbo run`, which pipe the output.\n',
    )
    process.exit(PIPED)
  }

  await registerGrammars()

  const renderer = await createCliRenderer({ useMouse: true, exitOnCtrlC: false, targetFps: 120 })
  renderer.on('destroy', () => process.exit(0))

  createRoot(renderer).render(<FooterPills />)
}
