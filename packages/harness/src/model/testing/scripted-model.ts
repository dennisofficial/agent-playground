import type { LanguageModelV4FinishReason, LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'

import { EFinishReason, type ProviderOptions } from '@dltech/atlas-core'

export type ScriptedReasoning = {
  text: string
  signature?: string
  startMetadata?: ProviderOptions
  deltaMetadata?: ProviderOptions
}

export type ScriptedCall = { callId: string; name: string; input: unknown }

export type ScriptedStep = {
  reasoning?: ScriptedReasoning
  text?: string
  leaveTextOpen?: boolean
  calls?: readonly ScriptedCall[]
  error?: unknown
  finishReason?: EFinishReason
}

const REASONING_BLOCK_ID = 'scripted-reasoning'
const TEXT_BLOCK_ID = 'scripted-text'

const scriptedUsage: LanguageModelV4Usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

const carriedMetadata = (metadata: ProviderOptions | undefined) =>
  metadata === undefined ? {} : { providerMetadata: metadata }

const unifiedFinishReason = (step: ScriptedStep): LanguageModelV4FinishReason['unified'] => {
  const declared = step.finishReason
  if (declared === EFinishReason.Length) return 'length'
  if (declared === EFinishReason.ContentFilter) return 'content-filter'
  if (declared === EFinishReason.Error) return 'error'
  if (declared === EFinishReason.Other) return 'other'
  if (declared === EFinishReason.ToolCalls) return 'tool-calls'
  if (declared === EFinishReason.Stop) return 'stop'
  return (step.calls?.length ?? 0) > 0 ? 'tool-calls' : 'stop'
}

const reasoningParts = (reasoning: ScriptedReasoning): LanguageModelV4StreamPart[] => [
  { type: 'reasoning-start', id: REASONING_BLOCK_ID, ...carriedMetadata(reasoning.startMetadata) },
  {
    type: 'reasoning-delta',
    id: REASONING_BLOCK_ID,
    delta: reasoning.text,
    ...carriedMetadata(reasoning.deltaMetadata),
  },
  {
    type: 'reasoning-end',
    id: REASONING_BLOCK_ID,
    ...carriedMetadata(reasoning.signature === undefined ? undefined : { anthropic: { signature: reasoning.signature } }),
  },
]

export function providerPartsFor(step: ScriptedStep): LanguageModelV4StreamPart[] {
  const parts: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }]

  if (step.reasoning !== undefined) parts.push(...reasoningParts(step.reasoning))

  if (step.text !== undefined) {
    parts.push({ type: 'text-start', id: TEXT_BLOCK_ID }, { type: 'text-delta', id: TEXT_BLOCK_ID, delta: step.text })
    if (step.leaveTextOpen !== true) parts.push({ type: 'text-end', id: TEXT_BLOCK_ID })
  }

  for (const call of step.calls ?? []) {
    parts.push({
      type: 'tool-call',
      toolCallId: call.callId,
      toolName: call.name,
      input: JSON.stringify(call.input),
    })
  }

  if (step.error !== undefined) parts.push({ type: 'error', error: step.error })

  parts.push({
    type: 'finish',
    usage: scriptedUsage,
    finishReason: { unified: unifiedFinishReason(step), raw: undefined },
  })

  return parts
}

export function scriptedModel(args: {
  script: readonly ScriptedStep[]
  provider?: string
  modelId?: string
}): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    ...(args.provider === undefined ? {} : { provider: args.provider }),
    ...(args.modelId === undefined ? {} : { modelId: args.modelId }),
    doStream: args.script.map((step) => ({
      stream: simulateReadableStream<LanguageModelV4StreamPart>({
        chunks: providerPartsFor(step),
        initialDelayInMs: 0,
        chunkDelayInMs: 0,
      }),
    })),
  })
}
