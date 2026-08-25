import { getErrorMessage } from '@ai-sdk/provider'
import { stepCountIs, streamText, type LanguageModel } from 'ai'

import type {
  Chunk,
  ChunkFilter,
  ModelPort,
  ModelStepResult,
  ProviderIdentity,
  ProviderPrompt,
  ToolDeclaration,
} from '@dltech/atlas-core'

import { createPartAccumulator } from './accumulator'
import { toCoreChunk } from './chunk-conversion'
import { ModelStreamError } from './errors'
import { toInstructions } from './instructions'
import { toModelMessages } from './message-conversion'
import { toProviderPrompt } from './provider-prompt'
import { toToolSet } from './tool-set'

export type { ChunkFilter }

// streamText's default onError writes the error to the console. The error chunk is already turned
// into a thrown ModelStreamError below, and a stray console write corrupts the terminal renderer.
const reportNothing = () => {}

export async function runModelStream(args: {
  model: LanguageModel
  prompt: ProviderPrompt
  tools: readonly ToolDeclaration[]
  signal: AbortSignal
  onChunk?: ChunkFilter
}): Promise<ModelStepResult> {
  const instructions = toInstructions(args.prompt.instructions)

  const stream = streamText({
    model: args.model,
    ...(instructions.length > 0 ? { instructions } : {}),
    messages: toModelMessages(args.prompt.messages),
    tools: toToolSet(args.tools),
    stopWhen: stepCountIs(1),
    abortSignal: args.signal,
    onError: reportNothing,
  })

  const accumulator = createPartAccumulator()

  for await (const part of stream.fullStream) {
    if (part.type === 'error') {
      throw new ModelStreamError({ message: getErrorMessage(part.error), cause: part.error })
    }

    const chunk = toCoreChunk(part)
    if (chunk === null) continue

    const kept = args.onChunk ? args.onChunk(chunk) : chunk
    if (kept !== null) accumulator.handle(kept)
  }

  return accumulator.finish()
}

export function createAiSdkModelPort(args: { model: LanguageModel; identity: ProviderIdentity }): ModelPort {
  return {
    identity: args.identity,

    step: ({ assembled, tools, signal, onChunk }) =>
      runModelStream({
        model: args.model,
        prompt: toProviderPrompt({ assembled, provider: args.identity }),
        tools,
        signal,
        ...(onChunk === undefined ? {} : { onChunk }),
      }),
  }
}
