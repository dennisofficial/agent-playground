import type { CallId } from '../events/ids'
import type { ProviderOptions } from '../provider'

export enum EFinishReason {
  Stop = 'stop',
  Length = 'length',
  ToolCalls = 'tool-calls',
  ContentFilter = 'content-filter',
  Error = 'error',
  Other = 'other',
}

export type ModelUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export type Chunk =
  | { type: 'text-start'; id: string; providerMetadata?: ProviderOptions }
  | { type: 'text-delta'; id: string; text: string; providerMetadata?: ProviderOptions }
  | { type: 'text-end'; id: string; providerMetadata?: ProviderOptions }
  | { type: 'reasoning-start'; id: string; providerMetadata?: ProviderOptions }
  | { type: 'reasoning-delta'; id: string; text: string; providerMetadata?: ProviderOptions }
  | { type: 'reasoning-end'; id: string; providerMetadata?: ProviderOptions }
  | { type: 'tool-input-start'; callId: CallId; name: string }
  | { type: 'tool-input-delta'; callId: CallId; text: string }
  | { type: 'tool-input-end'; callId: CallId }
  | { type: 'tool-call'; callId: CallId; name: string; input: unknown }
  | { type: 'finish'; reason: EFinishReason; usage?: ModelUsage }
  | { type: 'error'; message: string }

export type ChunkType = Chunk['type']

export enum EBlockKind {
  Text = 'text',
  Reasoning = 'reasoning',
}
