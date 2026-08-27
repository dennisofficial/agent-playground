import { getErrorMessage, type SharedV4ProviderMetadata } from '@ai-sdk/provider'
import type { FinishReason, LanguageModelUsage, TextStreamPart, ToolSet } from 'ai'

import { EFinishReason, toCallId, type Chunk, type ModelUsage } from '@dltech/atlas-core'

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

/**
 * `inputTokens` is the whole prompt in AI SDK 7 — `@ai-sdk/anthropic`'s `convertAnthropicUsage`
 * returns `inputTokens.total = noCache + cacheRead + cacheWrite` — so the two totals are the context
 * as billed, and the details are a breakdown within `inputTokens` rather than an addition to it.
 * They are carried because the three input tiers bill at different rates.
 */
type InputTiers = Partial<LanguageModelUsage['inputTokenDetails']>

// ai@7's own `addLanguageModelUsage` reads `inputTokenDetails` through `?.`, so a provider reaching
// the stream without one is a shape the SDK itself expects.
const inputTiersOf = (usage: LanguageModelUsage): InputTiers => usage.inputTokenDetails ?? {}

const carriedUsage = (usage: LanguageModelUsage | undefined): { usage?: ModelUsage } => {
  if (usage === undefined) return {}
  const { inputTokens, outputTokens } = usage
  const { cacheReadTokens, cacheWriteTokens } = inputTiersOf(usage)
  const reportedNothing =
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined
  if (reportedNothing) return {}

  return {
    usage: {
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
      ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    },
  }
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

  if (part.type === 'finish') {
    return {
      type: 'finish',
      reason: toFinishReason(part.finishReason),
      ...carriedUsage(part.totalUsage),
    }
  }

  if (part.type === 'error') return { type: 'error', message: getErrorMessage(part.error) }

  return null
}
