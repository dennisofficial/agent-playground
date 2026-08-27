import type { Assembled } from '../assembly/assembled'
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

export abstract class ModelPort {
  abstract readonly identity: ProviderIdentity

  abstract step(args: {
    assembled: Assembled
    tools: readonly ToolDeclaration[]
    signal: AbortSignal
    onChunk?: ChunkFilter
  }): Promise<ModelStepResult>
}
