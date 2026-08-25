import type { SharedV4ProviderMetadata } from '@ai-sdk/provider'
import type { FinishReason, TextStreamPart, ToolSet } from 'ai'

import { EFinishReason, toCallId, type Chunk } from '@dltech/atlas-core'

import { toCoreProviderOptions } from './provider-options'

export const toFinishReason = (reason: FinishReason): EFinishReason => {
  if (reason === 'stop') return EFinishReason.Stop
  if (reason === 'length') return EFinishReason.Length
  if (reason === 'tool-calls') return EFinishReason.ToolCalls
  if (reason === 'content-filter') return EFinishReason.ContentFilter
  if (reason === 'error') return EFinishReason.Error
  return EFinishReason.Other
}

const carriedMetadata = (part: { providerMetadata?: SharedV4ProviderMetadata }) => {
  const providerMetadata = toCoreProviderOptions(part.providerMetadata)
  return providerMetadata === undefined ? {} : { providerMetadata }
}

export function toCoreChunk(part: TextStreamPart<ToolSet>): Chunk | null {
  if (part.type === 'text-start') return { type: 'text-start', id: part.id, ...carriedMetadata(part) }
  if (part.type === 'text-delta') return { type: 'text-delta', id: part.id, text: part.text, ...carriedMetadata(part) }
  if (part.type === 'text-end') return { type: 'text-end', id: part.id, ...carriedMetadata(part) }

  if (part.type === 'reasoning-start') return { type: 'reasoning-start', id: part.id, ...carriedMetadata(part) }
  if (part.type === 'reasoning-delta') {
    return { type: 'reasoning-delta', id: part.id, text: part.text, ...carriedMetadata(part) }
  }
  if (part.type === 'reasoning-end') return { type: 'reasoning-end', id: part.id, ...carriedMetadata(part) }

  if (part.type === 'tool-call') {
    return { type: 'tool-call', callId: toCallId(part.toolCallId), name: part.toolName, input: part.input }
  }

  if (part.type === 'finish') return { type: 'finish', reason: toFinishReason(part.finishReason) }

  return null
}
