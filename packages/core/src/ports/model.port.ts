import type { Assembled } from '../assembly/assembled'
import { DEFAULT_IMAGE_TIER, type EImageTier } from '../images/projection'
import type { AssistantPart } from '../events/body'
import type { CallId } from '../events/ids'
import type { ProviderIdentity } from '../provider'
import type { Chunk, EFinishReason, ModelUsage } from '../stream/chunk'
import type { ToolDeclaration } from '../tools/tool'

export type ModelToolCall = { callId: CallId; name: string; input: unknown }

export type ChunkFilter = (chunk: Chunk) => Chunk | null

export type ModelStepResult = {
  parts: readonly AssistantPart[]
  toolCalls: readonly ModelToolCall[]
  finishReason: EFinishReason
  usage?: ModelUsage
}

export type ModelTraits = {
  imageTier?: EImageTier | undefined
  contextWindow?: number | undefined
}

export const CONTEXT_WINDOW_UNMEASURED = 0

export const imageTierOf = (model: { traits?: () => ModelTraits }): EImageTier =>
  model.traits?.().imageTier ?? DEFAULT_IMAGE_TIER

export const contextWindowOf = (model: { traits?: () => ModelTraits }): number =>
  model.traits?.().contextWindow ?? CONTEXT_WINDOW_UNMEASURED

export abstract class ModelPort {
  abstract readonly identity: ProviderIdentity

  traits?(): ModelTraits

  abstract step(args: {
    assembled: Assembled
    tools: readonly ToolDeclaration[]
    signal: AbortSignal
    onChunk?: ChunkFilter
  }): Promise<ModelStepResult>
}
