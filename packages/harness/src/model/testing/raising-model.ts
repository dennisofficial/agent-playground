import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { MockLanguageModelV4 } from 'ai/test'

import { providerPartsFor } from './scripted-model'

const whenAborted = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    signal.addEventListener('abort', () => resolve(), { once: true })
  })

export function raisingModel(args: {
  head: string
  error: unknown
  waitFor?: AbortSignal | undefined
}): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => {
      const pending = providerPartsFor({ text: args.head, leaveTextOpen: true }).filter(
        (part) => part.type !== 'finish',
      )

      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          async pull(controller) {
            const next = pending.shift()
            if (next !== undefined) return controller.enqueue(next)

            if (args.waitFor !== undefined) await whenAborted(args.waitFor)
            controller.error(args.error)
          },
        }),
      }
    },
  })
}
