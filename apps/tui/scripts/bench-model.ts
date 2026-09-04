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

export const STEP_TEXT = [
  ...Array.from({ length: 128 }, (_, index) => reportLine(index)),
  CODE_BLOCK,
  ...Array.from({ length: 127 }, (_, index) => reportLine(index + 128)),
].join('\n')

let streamedParts = 0

export const chunksStreamed = (): number => streamedParts

export const benchModel = (): MockLanguageModelV4 => {
  const parts = providerPartsFor({ text: STEP_TEXT })
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
