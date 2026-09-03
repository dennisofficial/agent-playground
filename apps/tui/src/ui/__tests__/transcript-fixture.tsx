import { useKeyboard, useTerminalDimensions } from '@opentui/react'
import { testRender } from '@opentui/react/test-utils'
import React, { useState } from 'react'

import {
  EAuthor,
  EEntryKind,
  type PendingRow,
  type TranscriptEntry,
  type TranscriptModel,
  type TurnEndedEntry,
} from '../../store'
import type { BackgroundWork } from '../background-wait'
import { Transcript, type TurnClock } from '../components/transcript'
import { teardown } from '../markdown/__tests__/harness'
import { frameSettled } from './waiting'

export const WIDTHS = [40, 60, 100, 200] as const

export const HEIGHT = 30

export const CWD = '/Users/dennis/Developer/atlas'

export const HOME = '/Users/dennis'

export const MODEL_ID = 'claude-opus-5'

const LONG_REPLY = [
  '## What I found',
  '',
  'The loop hands every turn to `assemble`, which is pure — a long sentence that has to wrap somewhere sensible even when the terminal is three hundred columns wide and nothing else is competing for the room.',
  '',
  '- one',
  '- two',
  '  - nested',
  '',
  '```ts',
  'const assembled = assemble({ events, rules })',
  '```',
  '',
  '| Engine | Model |',
  '| --- | --- |',
  '| claude | opus |',
].join('\n')

const operatorSaid = (
  key: string,
  text: string,
  flags: { steer?: boolean } = {},
): TranscriptEntry => ({
  kind: EEntryKind.OperatorSaid,
  author: EAuthor.Operator,
  key,
  text,
  said: [text],
  steer: flags.steer ?? false,
  skills: [],
  files: [],
    images: [],
})

type ModelFlags = { streaming?: boolean; interrupted?: boolean }

const modelSaid = (key: string, text: string, flags: ModelFlags = {}): TranscriptEntry => ({
  kind: EEntryKind.ModelSaid,
  author: EAuthor.Model,
  key,
  text,
  streaming: flags.streaming ?? false,
  interrupted: flags.interrupted ?? false,
})

const modelThought = (key: string, text: string, flags: ModelFlags = {}): TranscriptEntry => ({
  kind: EEntryKind.ModelThought,
  author: EAuthor.Model,
  key,
  text,
  streaming: flags.streaming ?? false,
  heldOpen: false,
  interrupted: flags.interrupted ?? false,
})

const model = (
  entries: TranscriptEntry[],
  rest: Partial<TranscriptModel> = {},
): TranscriptModel => ({
  entries,
  isEmpty: entries.length === 0,
  streaming: false,
  failure: null,
  ...rest,
})

const turnEnded = (key: string, over: Partial<TurnEndedEntry> = {}): TranscriptEntry => ({
  kind: EEntryKind.TurnEnded,
  author: EAuthor.Model,
  key,
  text: '',
  durationMs: 54_000,
  outputTokens: 1_100,
  endedAt: new Date(2026, 7, 28, 18, 32).toISOString(),
  interrupted: false,
  ...over,
})

export const LAST_WORDS = 'Plain text entry, nothing else.'

export const SETTLED = model([
  operatorSaid('u1', 'port the transcript, keep `stickyScroll`'),
  modelThought('t1', 'The blocks are fine. The adapter beneath them is not.\n\nSo: rewrite it.'),
  modelSaid('a1', LONG_REPLY),
  operatorSaid('u2', 'and the composer?'),
  modelSaid('a2', LAST_WORDS),
])

export const FIRST_ASK = 'first thing I asked'

export const SECOND_ASK = 'second thing I asked'

const filler = (word: string): string =>
  Array.from({ length: 40 }, (_, line) => `${word} line ${line}`).join('\n\n')

export const THREADED = model([
  operatorSaid('u1', FIRST_ASK),
  modelSaid('a1', filler('alpha')),
  operatorSaid('u2', SECOND_ASK),
  modelSaid('a2', filler('beta')),
])

export const TURN_DONE = model([
  operatorSaid('u1', 'go'),
  modelSaid('a1', 'done'),
  turnEnded('turn-1'),
])

export const TURN_STOPPED = model([
  operatorSaid('u1', 'go'),
  modelSaid('a1', 'partial'),
  turnEnded('turn-1', {
    interrupted: true,
    durationMs: 12_000,
    outputTokens: 0,
  }),
])

export const STREAMING = model(
  [
    operatorSaid('u1', 'think about it first'),
    modelThought('t1', `${'A'.repeat(400)}\n\nstill going`, {
      streaming: true,
    }),
  ],
  { streaming: true },
)

export const STREAMING_REPLY = model(
  [
    operatorSaid('u1', 'answer'),
    modelSaid('a1', '## Half a doc\n\nand a `fenc', { streaming: true }),
  ],
  { streaming: true },
)

export const INTERRUPTED = model([
  operatorSaid('u1', 'go'),
  modelThought('t1', 'half a thought', { interrupted: true }),
  modelSaid('a1', 'half an answer', { interrupted: true }),
])

export const PARTIAL_REPLY = 'the partial reply that must survive'

export const FAILED_WITH_A_REASON = model(
  [operatorSaid('u1', 'go'), modelSaid('a1', PARTIAL_REPLY)],
  { failure: { message: 'overloaded_error: the model is overloaded' } },
)

export const FAILED_SILENTLY = model([operatorSaid('u1', 'go'), modelSaid('a1', 'partial')], {
  failure: { message: null },
})

export const RUNNING: TurnClock = {
  startedAt: 1_000,
  outputTokens: 1_280,
  interrupting: false,
  reasoning: false,
  completed: null,
  retry: null,
}

export const REASONING: TurnClock = { ...RUNNING, reasoning: true }

export const INTERRUPTING: TurnClock = { ...RUNNING, interrupting: true }

export const FINISHED: TurnClock = {
  startedAt: null,
  outputTokens: 0,
  interrupting: false,
  reasoning: false,
  completed: { durationMs: 92_000, outputTokens: 4_210 },
  retry: null,
}

export const NOW = 95_000

export function transcript(args: {
  model: TranscriptModel
  width: number
  turn?: TurnClock
  anchorKey?: string
  sends?: number
  pending?: readonly PendingRow[]
  background?: BackgroundWork
  waitingSince?: number
  onRetry?: () => void
}): React.ReactNode {
  return (
    <Transcript
      model={args.model}
      width={args.width}
      now={NOW}
      cwd={CWD}
      {...(args.turn ? { turn: args.turn } : {})}
      {...(args.anchorKey ? { anchorKey: args.anchorKey } : {})}
      {...(args.sends === undefined ? {} : { sends: args.sends })}
      {...(args.pending ? { pending: args.pending } : {})}
      {...(args.background ? { background: args.background } : {})}
      {...(args.waitingSince === undefined ? {} : { waitingSince: args.waitingSince })}
      {...(args.onRetry ? { onRetry: args.onRetry } : {})}
    />
  )
}

export function SizedTranscript(props: { model: TranscriptModel }): React.ReactNode {
  const { width } = useTerminalDimensions()
  return transcript({ model: props.model, width })
}

export function SendingTranscript(props: { model: TranscriptModel }): React.ReactNode {
  const { width } = useTerminalDimensions()
  const [sends, setSends] = useState(0)
  useKeyboard(() => setSends((count) => count + 1))
  return transcript({ model: props.model, width, sends })
}

export async function mount(node: React.ReactNode, width: number): Promise<void> {
  const setup = await testRender(
    <box flexDirection="column" width={width} height={HEIGHT}>
      {node}
    </box>,
    { width, height: HEIGHT },
  )
  try {
    await setup.flush()
  } finally {
    await teardown(setup)
  }
}

/**
 * A `<markdown>` renderable parses off the render pass, so its prose reaches the buffer a frame
 * after the one that mounted it: a capture taken straight after `flush()` shows the glyphs and an
 * empty column where every wrapped paragraph will be.
 */
export async function drawn(setup: {
  flush: () => Promise<void>
  captureCharFrame: () => string
}): Promise<string> {
  return frameSettled({ setup })
}

export async function frameOf(node: React.ReactNode, width: number): Promise<string> {
  const setup = await testRender(
    <box flexDirection="column" width={width} height={HEIGHT}>
      {node}
    </box>,
    { width, height: HEIGHT },
  )
  try {
    return await drawn(setup)
  } finally {
    await teardown(setup)
  }
}
