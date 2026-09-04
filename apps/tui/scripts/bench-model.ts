import { providerPartsFor } from '@dltech/atlas-harness'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'

const reportLine = (index: number): string =>
  `section ${index}: the worker drifted past its quota while the queue kept growing`

const CODE_BLOCK = [
  '```ts',
  'export const rebalance = (args: { queue: readonly Job[] }): readonly Job[] => {',
  '  const heavy = args.queue.filter((job) => job.cost > QUEUE_BUDGET)',
  '  const light = args.queue.filter((job) => job.cost <= QUEUE_BUDGET)',
  '  return [...heavy, ...light]',
  '}',
  '```',
].join('\n')

const paragraph = (from: number): string =>
  Array.from({ length: 4 }, (_, index) => reportLine(from + index)).join('\n')

export const STEP_TEXT = [
  ...Array.from({ length: 32 }, (_, index) => paragraph(index * 4)),
  CODE_BLOCK,
  ...Array.from({ length: 32 }, (_, index) => paragraph(128 + index * 4)),
].join('\n\n')

let streamedParts = 0

export const chunksStreamed = (): number => streamedParts

const DELTA_CHARACTERS = 48

type StreamParts = ReturnType<typeof providerPartsFor>

const splitDeltas = (parts: StreamParts): StreamParts =>
  parts.flatMap((part) => {
    if (part.type !== 'text-delta') return [part]
    const pieces: StreamParts = []
    for (let at = 0; at < part.delta.length; at += DELTA_CHARACTERS) {
      pieces.push({ ...part, delta: part.delta.slice(at, at + DELTA_CHARACTERS) })
    }
    return pieces
  })

export const benchModel = (): MockLanguageModelV4 => {
  const parts = splitDeltas(providerPartsFor({ text: STEP_TEXT }))
  return new MockLanguageModelV4({
    provider: 'bench',
    modelId: 'bench-kimi-speed',
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: parts, initialDelayInMs: 0, chunkDelayInMs: 0 }).pipeThrough(
        new TransformStream({
          transform: (part, controller) => {
            streamedParts += 1
            controller.enqueue(part)
          },
        }),
      ),
    }),
  })
}
