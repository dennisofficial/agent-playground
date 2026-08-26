import { getErrorMessage } from '@ai-sdk/provider'
import { stepCountIs, streamText, type LanguageModel } from 'ai'

import type {
  Chunk,
  ChunkFilter,
  ModelPort,
  ModelStepResult,
  OnChunk,
  ProviderIdentity,
  ProviderPrompt,
  ToolDeclaration,
} from '@dltech/atlas-core'

import { runBeforeRequest, runOnChunk, type HookRegistry, type RegisteredHook } from '../hooks/registry'
import { createPartAccumulator } from './accumulator'
import { toCoreChunk } from './chunk-conversion'
import { ModelStreamError } from './errors'
import { toInstructions } from './instructions'
import { toModelMessages } from './message-conversion'
import { toProviderPrompt } from './provider-prompt'
import { toToolSet } from './tool-set'

export type { ChunkFilter }

// streamText's default onError writes the error to the console, and a stray console write corrupts
// the terminal renderer.
const reportNothing = () => {}

async function keptChunk(args: {
  chunk: Chunk
  hooks: readonly RegisteredHook<OnChunk>[]
  filter?: ChunkFilter | undefined
}): Promise<Chunk | null> {
  const observed = await runOnChunk({ hooks: args.hooks, chunk: args.chunk })
  if (observed === null) return null
  if (args.filter === undefined) return observed
  return args.filter(observed)
}

export async function runModelStream(args: {
  model: LanguageModel
  prompt: ProviderPrompt
  tools: readonly ToolDeclaration[]
  signal: AbortSignal
  onChunk?: ChunkFilter
  onChunkHooks?: readonly RegisteredHook<OnChunk>[] | undefined
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

  try {
    for await (const part of stream.fullStream) {
      const chunk = toCoreChunk(part)
      if (chunk === null) continue

      const kept = await keptChunk({ chunk, hooks: args.onChunkHooks ?? [], filter: args.onChunk })
      if (kept !== null) accumulator.handle(kept)

      if (part.type === 'error') {
        throw new ModelStreamError({ message: getErrorMessage(part.error), cause: part.error })
      }
    }
  } catch (error) {
    if (!args.signal.aborted) throw error
  }

  return accumulator.finish()
}

export function createAiSdkModelPort(args: {
  model: LanguageModel
  identity: ProviderIdentity
  hooks?: HookRegistry | undefined
}): ModelPort {
  return {
    identity: args.identity,

    step: async ({ assembled, tools, signal, onChunk }) =>
      runModelStream({
        model: args.model,
        prompt: await runBeforeRequest({
          hooks: args.hooks?.beforeRequest ?? [],
          prompt: toProviderPrompt({ assembled, provider: args.identity }),
        }),
        tools,
        signal,
        onChunkHooks: args.hooks?.onChunk,
        ...(onChunk === undefined ? {} : { onChunk }),
      }),
  }
}
