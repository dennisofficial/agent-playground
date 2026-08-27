import { useTerminalDimensions } from '@opentui/react'
import { testRender } from '@opentui/react/test-utils'
import React from 'react'

import {
  EAuthor,
  EEntryKind,
  type PendingMessage,
  type TranscriptEntry,
  type TranscriptModel,
} from '../../store'
import { Transcript, type TurnClock } from '../components/transcript'
import { settle, teardown } from '../markdown/__tests__/harness'

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
  steer: flags.steer ?? false,
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

export const LAST_WORDS = 'Plain text entry, nothing else.'

export const SETTLED = model([
  operatorSaid('u1', 'port the transcript, keep `stickyScroll`'),
  modelThought('t1', 'The blocks are fine. The adapter beneath them is not.\n\nSo: rewrite it.'),
  modelSaid('a1', LONG_REPLY),
  operatorSaid('u2', 'and the composer?'),
  modelSaid('a2', LAST_WORDS),
])

export const STREAMING = model(
  [
    operatorSaid('u1', 'think about it first'),
    modelThought('t1', `${'A'.repeat(400)}\n\nstill going`, { streaming: true }),
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
  completed: null,
}

export const INTERRUPTING: TurnClock = { ...RUNNING, interrupting: true }

export const FINISHED: TurnClock = {
  startedAt: null,
  outputTokens: 0,
  interrupting: false,
  completed: { durationMs: 92_000, outputTokens: 4_210 },
}

export const NOW = 95_000

export function transcript(args: {
  model: TranscriptModel
  width: number
  turn?: TurnClock
  anchorKey?: string
  pending?: readonly PendingMessage[]
  onRetry?: () => void
}): React.ReactNode {
  return (
    <Transcript
      model={args.model}
      width={args.width}
      now={NOW}
      cwd={CWD}
      home={HOME}
      modelId={MODEL_ID}
      {...(args.turn ? { turn: args.turn } : {})}
      {...(args.anchorKey ? { anchorKey: args.anchorKey } : {})}
      {...(args.pending ? { pending: args.pending } : {})}
      {...(args.onRetry ? { onRetry: args.onRetry } : {})}
    />
  )
}

export function SizedTranscript(props: { model: TranscriptModel }): React.ReactNode {
  const { width } = useTerminalDimensions()
  return transcript({ model: props.model, width })
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

const PROSE_SETTLE_MS = 250

/**
 * A `<markdown>` renderable parses off the render pass, so its prose reaches the buffer a frame
 * after the one that mounted it: a capture taken straight after `flush()` shows the glyphs and an
 * empty column where every wrapped paragraph will be.
 */
export async function drawn(setup: {
  flush: () => Promise<unknown>
  captureCharFrame: () => string
}): Promise<string> {
  await setup.flush()
  await settle(PROSE_SETTLE_MS)
  await setup.flush()
  return setup.captureCharFrame()
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
