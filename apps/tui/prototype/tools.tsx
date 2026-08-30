// PROTOTYPE — throwaway. A real thread out of the sqlite store, drawn by the REAL transcript code.
//
// Everything it renders now lives in `src/`: `deriveTranscript`, `EntryView`, `ToolRunBlock`,
// `classify`, `aggregate`. What is left here is a harness — read a thread, flip the two settings that
// have no UI yet, and watch a run happen on a clock, which no settled transcript can show.
//
//   bun run proto:tools                     the busiest thread in ~/.atlas/dev.db
//   bun run proto:tools -- --list           what else is in there
//   bun run proto:tools -- --thread=brn_…   a specific one
//   bun run proto:tools -- --db=/path.db
//   bun run proto:tools -- --no-live        drop the replayed in-flight run at the end
//
// It must own a real terminal: `bun run --filter` and `turbo run` both pipe a script's output, which
// leaves stdin un-raw and sizes the renderer to a default rather than the window.
//
// m cycles the tool gutter, t cycles thinking, click a row to open it, o/O open or close everything.

import type { Event } from '@dltech/atlas-core'
import { createCliRenderer } from '@opentui/core'
import { createRoot, useKeyboard, useTerminalDimensions } from '@opentui/react'
import React, { useCallback, useMemo, useState } from 'react'

import {
  deriveTranscript,
  EEntryKind,
  EThinkingVisibility,
  toolRuns,
  type ToolRun,
  type TranscriptEntry,
} from '../src/store'
import { EntryView } from '../src/ui/components/entry-view'
import { toolsRanEntry } from '../src/store'
import { useShimmerClock } from '../src/ui/hooks/use-shimmer-clock'
import { registerGrammars } from '../src/ui/markdown/grammars/index'
import { theme, TRANSCRIPT_PADDING } from '../src/ui/theme'
import { EMark, MARK_ORDER } from '../src/ui/tool-marks'
import { busiestRun, liveRunAt } from './tools/live'
import { databasePath, loadThread, threadsIn } from './tools/load'

const NO_SIGNALS = Object.freeze([])

type Loaded = {
  title: string
  events: readonly Event[]
  cwd: string
  eventCount: number
  toolCount: number
  script: ToolRun | null
  live: boolean
}

const THINKING_ORDER: readonly EThinkingVisibility[] = [
  EThinkingVisibility.Keep,
  EThinkingVisibility.Stream,
  EThinkingVisibility.Hidden,
]

const THINKING_WORDS: Record<EThinkingVisibility, string> = {
  [EThinkingVisibility.Keep]: 'shown',
  [EThinkingVisibility.Stream]: 'streaming only',
  [EThinkingVisibility.Hidden]: 'hidden',
}

function Bar(props: {
  loaded: Loaded
  thinking: EThinkingVisibility
  mark: EMark
  width: number
}): React.ReactNode {
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      backgroundColor={theme.panelBg}
      paddingLeft={2}
      paddingRight={2}
    >
      <text fg={theme.hover}>{props.loaded.title}</text>
      <text fg={theme.rule}>
        {` · ${props.loaded.eventCount} events · ${props.loaded.toolCount} calls · o/O open all · ${props.width} cols`}
      </text>
      <box flexGrow={1} />
      <text fg={theme.meta}>
        {`m · gutter ${props.mark}    t · thinking ${THINKING_WORDS[props.thinking]}`}
      </text>
    </box>
  )
}

const everyKeyOf = (entries: readonly TranscriptEntry[]): Set<string> => {
  const keys = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== EEntryKind.ToolsRan) continue
    keys.add(entry.key)
    for (const call of entry.run.calls) {
      keys.add(call.callId)
      keys.add(`sentence:${call.callId}`)
    }
  }
  return keys
}

function Prototype(props: { loaded: Loaded }): React.ReactNode {
  const { width } = useTerminalDimensions()
  const [thinking, setThinking] = useState(EThinkingVisibility.Keep)
  const [markIndex, setMarkIndex] = useState(0)
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set<string>())
  const now = useShimmerClock({ active: props.loaded.live, intervalMs: 80 })
  const mark = MARK_ORDER[markIndex % MARK_ORDER.length] ?? EMark.Dim

  const model = useMemo(
    () => deriveTranscript({ events: props.loaded.events, signals: NO_SIGNALS, thinking }),
    [props.loaded.events, thinking],
  )
  const everyKey = useMemo(() => everyKeyOf(model.entries), [model.entries])
  const live = props.loaded.live ? liveRunAt({ script: props.loaded.script, now }) : null
  const entries = live === null ? model.entries : [...model.entries, toolsRanEntry(live)]

  const handleToggle = useCallback((key: string) => {
    setOpened((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])

  useKeyboard((key) => {
    if (key.eventType === 'release') return
    if (key.name === 'o') setOpened(key.shift ? new Set<string>() : everyKey)
    if (key.name === 'm') setMarkIndex((current) => current + 1)
    if (key.name === 't') {
      setThinking((current) => {
        const next = THINKING_ORDER.indexOf(current) + 1
        return THINKING_ORDER[next % THINKING_ORDER.length] ?? EThinkingVisibility.Keep
      })
    }
  })

  const reading = Math.max(24, width - 4)

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0}>
      <Bar loaded={props.loaded} thinking={thinking} mark={mark} width={width} />
      <scrollbox
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        focusable={false}
        stickyScroll
        stickyStart="bottom"
        contentOptions={{ paddingRight: TRANSCRIPT_PADDING, paddingLeft: 1, paddingTop: 1 }}
      >
        {entries.map((entry, index) => (
          <box key={entry.key} flexDirection="column">
            <EntryView
              entry={entry}
              width={reading}
              cwd={props.loaded.cwd}
              mark={mark}
              expanded={opened.has(entry.key)}
              opened={opened}
              onToggle={handleToggle}
              continues={entries[index - 1]?.kind === EEntryKind.ToolsRan}
            />
          </box>
        ))}
      </scrollbox>
    </box>
  )
}

const PIPED = 1

function argOf(argv: readonly string[], flag: string): string | undefined {
  const found = argv.find((arg) => arg.startsWith(`--${flag}=`))
  return found?.slice(flag.length + 3)
}

const cwdOf = (events: readonly Event[]): string => {
  for (const event of events) if (event.type === 'cwd-changed') return event.path
  return process.cwd()
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const path = databasePath(argv)

  if (argv.includes('--list')) {
    for (const row of threadsIn(path)) {
      process.stdout.write(
        `${row.id}  ${String(row.tools).padStart(4)} calls  ${String(row.events).padStart(4)} events  ${row.title ?? '(untitled)'}\n`,
      )
    }
    process.exit(0)
  }

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write(
      'This prototype needs a real terminal. Run `bun run proto:tools` from the repo root — ' +
        'not through `bun run --filter` or `turbo run`, which pipe the output.\n',
    )
    process.exit(PIPED)
  }

  const threadId = argOf(argv, 'thread')
  const thread = loadThread({ path, ...(threadId === undefined ? {} : { threadId }) })
  const loaded: Loaded = {
    title: thread.thread.title ?? '(untitled)',
    events: thread.events,
    cwd: cwdOf(thread.events),
    eventCount: thread.thread.events,
    toolCount: thread.thread.tools,
    script: busiestRun(toolRuns(thread.events)),
    live: !argv.includes('--no-live'),
  }

  await registerGrammars()

  const renderer = await createCliRenderer({ useMouse: true, exitOnCtrlC: true, targetFps: 60 })
  renderer.on('destroy', () => process.exit(0))

  createRoot(renderer).render(<Prototype loaded={loaded} />)
}
