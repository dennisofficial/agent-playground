import { getErrorMessage } from '@ai-sdk/provider'
import { stepCountIs, streamText, type LanguageModel } from 'ai'

import {
  ModelPort,
  type Assembled,
  type Chunk,
  type ChunkFilter,
  type ModelStepResult,
  type ProviderIdentity,
  type ProviderPrompt,
  type ToolDeclaration,
} from '@dltech/atlas-core'

import type { HookChain } from '../hooks/registry'
import { NO_RAW_TAPE, type RawTape } from './raw-tape'
import { createPartAccumulator } from './accumulator'
import { toCoreChunk } from './chunk-conversion'
import { ModelStreamError } from './errors'
import { toInstructions } from './instructions'
import { providerIdentityOf } from './provider-identity'
import { toModelMessages } from './message-conversion'
import { toProviderPrompt } from './provider-prompt'
import { toToolSet } from './tool-set'

export type { ChunkFilter }

// streamText's default onError writes the error to the console, and a stray console write corrupts
// the terminal renderer.
const reportNothing = () => {}

async function keptChunk(args: {
  chunk: Chunk
  hooks: HookChain | undefined
  filter?: ChunkFilter | undefined
}): Promise<Chunk | null> {
  const observed =
    args.hooks === undefined ? args.chunk : await args.hooks.onChunk({ chunk: args.chunk })
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
  hooks?: HookChain | undefined
  tape?: RawTape | undefined
}): Promise<ModelStepResult> {
  const instructions = toInstructions(args.prompt.instructions)
  const tape = args.tape ?? NO_RAW_TAPE

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
      tape.tap(part)

      const chunk = toCoreChunk(part)
      if (chunk === null) continue

      const kept = await keptChunk({ chunk, hooks: args.hooks, filter: args.onChunk })
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

export type AiSdkModelPortArgs = {
  model: LanguageModel
  identity?: ProviderIdentity | undefined
  hooks?: HookChain | undefined
  tape?: RawTape | undefined
}

export class AiSdkModelPort extends ModelPort {
  private readonly model: LanguageModel
  private readonly declaredIdentity: ProviderIdentity | undefined
  private readonly hooks: HookChain | undefined
  private readonly tape: RawTape | undefined

  constructor(args: AiSdkModelPortArgs) {
    super()
    this.model = args.model
    this.declaredIdentity = args.identity
    this.hooks = args.hooks
    this.tape = args.tape
  }

  get identity(): ProviderIdentity {
    return this.declaredIdentity ?? providerIdentityOf(this.model)
  }

  async step({
    assembled,
    tools,
    signal,
    onChunk,
  }: {
    assembled: Assembled
    tools: readonly ToolDeclaration[]
    signal: AbortSignal
    onChunk?: ChunkFilter
  }): Promise<ModelStepResult> {
    return runModelStream({
      model: this.model,
      prompt: await this.promptFor({ assembled }),
      tools,
      signal,
      ...(this.hooks === undefined ? {} : { hooks: this.hooks }),
      ...(onChunk === undefined ? {} : { onChunk }),
      ...(this.tape === undefined ? {} : { tape: this.tape }),
    })
  }

  private async promptFor({ assembled }: { assembled: Assembled }): Promise<ProviderPrompt> {
    const prompt = toProviderPrompt({ assembled, provider: this.identity })
    if (this.hooks === undefined) return prompt
    return this.hooks.beforeRequest({ prompt })
  }
}
