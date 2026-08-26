import {
  EBlockKind,
  EFinishReason,
  type AssistantPart,
  type Chunk,
  type ModelStepResult,
  type ModelToolCall,
  type ProviderOptions,
} from '@dltech/atlas-core'

import { carriedProviderOptions, mergeProviderOptions } from './provider-options'

type OpenBlock = { kind: EBlockKind; text: string; providerOptions: ProviderOptions | undefined }

const saysNothing = (text: string): boolean => text.trim() === ''

export type PartAccumulator = {
  handle(chunk: Chunk): void
  finish(): ModelStepResult
}

export function createPartAccumulator(): PartAccumulator {
  const open = new Map<string, OpenBlock>()
  const openedOrder: string[] = []
  const parts: AssistantPart[] = []
  const toolCalls: ModelToolCall[] = []
  let finishReason = EFinishReason.Other

  const handleStart = (args: { id: string; kind: EBlockKind; providerMetadata: ProviderOptions | undefined }) => {
    if (open.has(args.id)) return
    open.set(args.id, { kind: args.kind, text: '', providerOptions: args.providerMetadata })
    openedOrder.push(args.id)
  }

  const handleDelta = (args: { id: string; text: string; providerMetadata: ProviderOptions | undefined }) => {
    const block = open.get(args.id)
    if (!block) return
    block.text += args.text
    block.providerOptions = mergeProviderOptions({ base: block.providerOptions, incoming: args.providerMetadata })
  }

  const handleClose = (args: { id: string; providerMetadata: ProviderOptions | undefined }) => {
    const block = open.get(args.id)
    if (!block) return
    open.delete(args.id)

    const providerOptions = mergeProviderOptions({ base: block.providerOptions, incoming: args.providerMetadata })
    const carried = carriedProviderOptions(providerOptions)

    if (block.kind === EBlockKind.Reasoning) {
      parts.push({ type: 'reasoning', text: block.text, ...carried })
      return
    }
    if (saysNothing(block.text)) return

    parts.push({ type: 'text', text: block.text, ...carried })
  }

  return {
    handle(chunk) {
      if (chunk.type === 'text-start') {
        return handleStart({ id: chunk.id, kind: EBlockKind.Text, providerMetadata: chunk.providerMetadata })
      }
      if (chunk.type === 'reasoning-start') {
        return handleStart({ id: chunk.id, kind: EBlockKind.Reasoning, providerMetadata: chunk.providerMetadata })
      }
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        return handleDelta({ id: chunk.id, text: chunk.text, providerMetadata: chunk.providerMetadata })
      }
      if (chunk.type === 'text-end' || chunk.type === 'reasoning-end') {
        return handleClose({ id: chunk.id, providerMetadata: chunk.providerMetadata })
      }
      if (chunk.type === 'tool-call') {
        toolCalls.push({ callId: chunk.callId, name: chunk.name, input: chunk.input })
        return
      }
      if (chunk.type === 'finish') {
        finishReason = chunk.reason
      }
    },

    finish() {
      for (const id of openedOrder) handleClose({ id, providerMetadata: undefined })
      return { parts, toolCalls, finishReason }
    },
  }
}
