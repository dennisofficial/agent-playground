import { describe, expect, it } from 'bun:test'

import {
  CONTEXT_WINDOW_UNMEASURED,
  EImageTier,
  contextWindowOf,
  imageTierOf,
  type ModelCard,
} from '@dltech/atlas-core'

import { FaultingModelPort } from '../faulting-model'
import { AiSdkModelPort } from '../ai-sdk-model-port'

const cardOf = (args: { modelId: string; contextWindow: number; tier: EImageTier }): ModelCard => ({
  ref: { providerId: 'anthropic', modelId: args.modelId },
  label: args.modelId,
  api: 'anthropic-messages',
  contextWindow: args.contextWindow,
  imageTier: args.tier,
})

const OPUS = cardOf({
  modelId: 'claude-opus-5',
  contextWindow: 1_000_000,
  tier: EImageTier.HighResolution,
})

const HAIKU = cardOf({
  modelId: 'claude-haiku-4-5',
  contextWindow: 200_000,
  tier: EImageTier.Standard,
})

const stub = { specificationVersion: 'v4', provider: 'anthropic', modelId: 'x' } as never

describe('the window a port reports', () => {
  it('follows the switcher, because the card is read per turn rather than captured', () => {
    let chosen = OPUS
    const port = new AiSdkModelPort({ model: stub, card: () => chosen })

    expect(contextWindowOf(port)).toBe(1_000_000)
    expect(imageTierOf(port)).toBe(EImageTier.HighResolution)

    chosen = HAIKU
    expect(contextWindowOf(port)).toBe(200_000)
    expect(imageTierOf(port)).toBe(EImageTier.Standard)
  })

  it('survives the fault-injecting decorator, which the turn loop reads through', () => {
    const inner = new AiSdkModelPort({ model: stub, card: OPUS })
    const faulting = new FaultingModelPort({ inner, spec: { times: 1, status: 529 } })

    expect(contextWindowOf(faulting)).toBe(1_000_000)
    expect(imageTierOf(faulting)).toBe(EImageTier.HighResolution)
  })

  it('reads unmeasured when no card was supplied, which switches auto-compact off', () => {
    const port = new AiSdkModelPort({ model: stub })

    expect(contextWindowOf(port)).toBe(CONTEXT_WINDOW_UNMEASURED)
  })
})
