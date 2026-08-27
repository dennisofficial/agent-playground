// PROTOTYPE — throwaway. Not shipped, not imported by src/. Pick a direction, fold it in, delete it.
//
//   bun run proto:shell        (from the repo root)
//
// It must own a real terminal. `bun run --filter` and `turbo run` both multiplex a script's output
// through a pipe, which leaves stdin un-raw — mouse reports then echo as ^[[<35;73;37M and the
// renderer sizes itself to a default rather than the window.
//
// The transcript, composer and Panel are the real components. Only the shell around them varies.

import { createCliRenderer } from '@opentui/core'
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react'
import React, { useCallback, useState } from 'react'

import { Composer, composerRows, EComposerTone } from '../src/ui/components/composer'
import { ComposerHints, type Hint } from '../src/ui/components/composer-hints'
import { Transcript } from '../src/ui/components/transcript'
import { useDraft } from '../src/ui/hooks/use-draft'
import { registerGrammars } from '../src/ui/markdown/grammars/index'
import {
  EAuthor,
  EEntryKind,
  EMPTY_TRANSCRIPT,
  type TranscriptEntry,
  type TranscriptModel,
} from '../src/store'
import { glyph, theme, SIDEBAR_WIDTH } from '../src/ui/theme'
import { CWD, HOME, MODEL, MODEL_ID, WHERE } from './session'
import { QuietSidebar, RailedSidebar, StripSidebar } from './sidebars'

const said = (key: string, text: string): TranscriptEntry => ({
  kind: EEntryKind.OperatorSaid,
  author: EAuthor.Operator,
  key,
  text,
  said: [text],
  steer: false,
})

const replied = (key: string, text: string): TranscriptEntry => ({
  kind: EEntryKind.ModelSaid,
  author: EAuthor.Model,
  key,
  text,
  streaming: false,
  interrupted: false,
})

const thought = (key: string, text: string): TranscriptEntry => ({
  kind: EEntryKind.ModelThought,
  author: EAuthor.Model,
  key,
  text,
  streaming: false,
  interrupted: false,
})

const CONVERSATION: TranscriptModel = {
  entries: [
    said('u1', 'give the whole app one shape'),
    thought(
      't1',
      'A cap means the thing has an end. A reply that is still arriving does not have one,\nso prose gets a bare rail and only bounded things get capped.',
    ),
    replied(
      'a1',
      [
        'Two readings of the same primitive:',
        '',
        '- **filled and capped** — something you can point at: your message, a failure, the draft',
        '- **bare rail** — something that runs on: a reply, a thought',
        '',
        '```ts',
        '<Panel rail={theme.accent} fill={theme.panelBg}>…</Panel>',
        '<Panel rail={theme.accent}>…</Panel>',
        '```',
      ].join('\n'),
    ),
    said('u2', 'and the shell around it?'),
    replied('a2', 'That is what you are picking. `ctrl+n` cycles the three directions.'),
  ],
  isEmpty: false,
  streaming: false,
  failure: null,
}

const IDLE_HINTS: readonly Hint[] = [
  { key: '⏎', label: 'send' },
  { key: '⇧⏎', label: 'newline' },
  { key: 'ctrl+n', label: 'new' },
  { key: 'ctrl+b', label: 'sidebar' },
  { key: 'ctrl+c', label: 'quit' },
]

const BUSY_HINTS: readonly Hint[] = [
  { key: 'esc', label: 'interrupt' },
  { key: 'ctrl+b', label: 'sidebar' },
]

function Strip(props: { width: number }): React.ReactNode {
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      width={props.width}
      backgroundColor={theme.panelBg}
      paddingLeft={2}
      paddingRight={2}
      gap={2}
    >
      <text flexShrink={0}>
        <span fg={theme.accent}>{glyph.block} </span>
        <span fg={theme.hover}>atlas</span>
      </text>
      <text fg={theme.hint} flexShrink={1}>
        {WHERE}
      </text>
      <box flexGrow={1} />
      <text fg={theme.hint} flexShrink={0}>
        {MODEL}
      </text>
    </box>
  )
}

type Direction = {
  name: string
  note: string
  strip: boolean
  sidebar: (props: { working: boolean }) => React.ReactNode
}

const DIRECTIONS: readonly Direction[] = [
  {
    name: 'quiet',
    note: 'sidebar is a filled column, sections held apart by spacing · no top strip',
    strip: false,
    sidebar: (props) => <QuietSidebar {...props} />,
  },
  {
    name: 'strip',
    note: 'identity moves to a top strip · sidebar holds only what is live',
    strip: true,
    sidebar: (props) => <StripSidebar {...props} />,
  },
  {
    name: 'divided',
    note: 'no filled regions but your words and the draft · a ┃ seam divides the columns',
    strip: false,
    sidebar: (props) => <RailedSidebar {...props} />,
  },
]

const TONES = [EComposerTone.Idle, EComposerTone.Working, EComposerTone.Interrupting] as const

function Bar(props: {
  width: number
  direction: Direction
  index: number
  tone: EComposerTone
  full: boolean
  onCycle: () => void
}): React.ReactNode {
  return (
    <box
      flexDirection="column"
      width={props.width}
      flexShrink={0}
      backgroundColor={theme.overlayBg}
      paddingLeft={1}
      paddingRight={1}
      onMouseDown={props.onCycle}
    >
      <text>
        <span fg={theme.accent}>{'PROTOTYPE  '}</span>
        <span fg={theme.hover}>
          {`${props.index + 1}/${DIRECTIONS.length} ${props.direction.name}`}
        </span>
        <span fg={theme.hint}>{`  ${props.direction.note}`}</span>
      </text>
      <text>
        <span fg={theme.meta}>ctrl+n</span>
        <span fg={theme.hint}> direction · </span>
        <span fg={theme.meta}>ctrl+t</span>
        <span fg={theme.hint}>{` tone (${props.tone}) · `}</span>
        <span fg={theme.meta}>ctrl+b</span>
        <span fg={theme.hint}> sidebar · </span>
        <span fg={theme.meta}>ctrl+y</span>
        <span fg={theme.hint}>{` transcript (${props.full ? 'full' : 'empty'}) · `}</span>
        <span fg={theme.meta}>ctrl+c</span>
        <span fg={theme.hint}> quit</span>
      </text>
    </box>
  )
}

export function Shell(): React.ReactNode {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const draft = useDraft()

  const [index, setIndex] = useState(0)
  const [toneAt, setToneAt] = useState(0)
  const [sidebar, setSidebar] = useState(true)
  const [full, setFull] = useState(true)

  const direction = DIRECTIONS[index] ?? (DIRECTIONS[0] as Direction)
  const tone = TONES[toneAt] ?? EComposerTone.Idle
  const busy = tone !== EComposerTone.Idle
  const contentWidth = width - (sidebar ? SIDEBAR_WIDTH : 0)

  const cycle = useCallback(() => setIndex((current) => (current + 1) % DIRECTIONS.length), [])

  useKeyboard((key) => {
    if (key.eventType === 'release' || !key.ctrl) return

    if (key.name === 'n') {
      key.preventDefault()
      cycle()
      return
    }
    if (key.name === 't') {
      key.preventDefault()
      setToneAt((current) => (current + 1) % TONES.length)
      return
    }
    if (key.name === 'b') {
      key.preventDefault()
      setSidebar((current) => !current)
      return
    }
    if (key.name === 'y') {
      key.preventDefault()
      setFull((current) => !current)
      return
    }
    if (key.name === 'c') {
      key.preventDefault()
      renderer.destroy()
    }
  })

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0}>
      <Bar
        width={width}
        direction={direction}
        index={index}
        tone={tone}
        full={full}
        onCycle={cycle}
      />

      {direction.strip ? <Strip width={width} /> : null}

      <box flexDirection="row" flexGrow={1} flexShrink={1} flexBasis={0}>
        <box flexDirection="column" width={contentWidth} flexGrow={1} flexShrink={1} flexBasis={0}>
          <Transcript
            model={full ? CONVERSATION : EMPTY_TRANSCRIPT}
            width={contentWidth}
            now={0}
            cwd={CWD}
            home={HOME}
            modelId={MODEL_ID}
          />
          <Composer
            draft={draft}
            width={contentWidth}
            tone={tone}
            placeholder="Ask anything"
            maxRows={composerRows(height)}
          />
          <ComposerHints
            width={contentWidth}
            hints={busy ? BUSY_HINTS : IDLE_HINTS}
            keyColour={busy ? theme.accent : theme.meta}
            {...(sidebar ? {} : { status: `${WHERE} · ${MODEL}` })}
          />
        </box>
        {sidebar ? direction.sidebar({ working: busy }) : null}
      </box>
    </box>
  )
}

const PIPED = 1

if (import.meta.main) {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write(
      'This prototype needs a real terminal. Run `bun run proto:shell` from the repo root — ' +
        'not through `bun run --filter` or `turbo run`, which pipe the output.\n',
    )
    process.exit(PIPED)
  }

  await registerGrammars()

  const renderer = await createCliRenderer({ useMouse: true, exitOnCtrlC: false, targetFps: 120 })
  renderer.on('destroy', () => process.exit(0))

  createRoot(renderer).render(<Shell />)
}
