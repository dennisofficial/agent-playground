import type { Assembled } from '../assembly/assembled'
import type { AssistantPart } from '../events/body'
import type { CallId } from '../events/ids'
import type { ProviderIdentity } from '../provider'
import type { Chunk, EFinishReason } from '../stream/chunk'
import type { ToolDeclaration } from '../tools/tool'

export type ModelToolCall = { callId: CallId; name: string; input: unknown }

export type ModelStepResult = {
  parts: readonly AssistantPart[]
  toolCalls: readonly ModelToolCall[]
  finishReason: EFinishReason
}

export interface ModelPort {
  readonly identity: ProviderIdentity

  step(args: {
    assembled: Assembled
    tools: readonly ToolDeclaration[]
    signal: AbortSignal
    onChunk?: (chunk: Chunk) => void
  }): Promise<ModelStepResult>
}
