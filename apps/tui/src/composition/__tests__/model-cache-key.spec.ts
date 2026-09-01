import { describe, expect, it } from 'bun:test'

import { EEffort, EImageTier, catalogOf, findCard, type ModelCard } from '@dltech/atlas-core'
import { ProviderAdapter } from '@dltech/atlas-harness'

import { selectableModel } from '../model-selection'
import type { ModelCatalogue } from '../providers'

type BuiltModel = ReturnType<ProviderAdapter['model']>

type EffortOptions = ReturnType<ProviderAdapter['effortOptions']>

const NEVER_CALLED = () => Promise.reject(new Error('the stub model does not answer'))

const cardOf = (modelId: string, contextWindow = 1_000_000): ModelCard => ({
  ref: { providerId: 'anthropic', modelId },
  label: modelId,
  api: 'anthropic-messages',
  contextWindow,
  imageTier: EImageTier.HighResolution,
  effort: { [EEffort.Low]: 'low', [EEffort.High]: 'high', [EEffort.XHigh]: 'xhigh' },
})

const OPUS = cardOf('claude-opus-5')

const SONNET = cardOf('claude-sonnet-5', 200_000)

const CARDS: readonly ModelCard[] = [OPUS, SONNET]

const CATALOG = catalogOf(CARDS)

class CountingAdapter extends ProviderAdapter {
  readonly id = 'anthropic'
  readonly label = 'Claude Plan'
  readonly built: string[] = []
  liveEffort: (() => EEffort) | undefined

  cards(): readonly ModelCard[] {
    return CARDS
  }

  effortOptions(args: { card: ModelCard; effort: EEffort }): EffortOptions {
    return { anthropic: { effort: args.effort } }
  }

  model(args: { card: ModelCard; effort: () => EEffort }): BuiltModel {
    this.built.push(args.card.ref.modelId)
    this.liveEffort = args.effort

    return {
      specificationVersion: 'v4',
      provider: this.id,
      modelId: args.card.ref.modelId,
      supportedUrls: {},
      doGenerate: NEVER_CALLED,
      doStream: NEVER_CALLED,
    }
  }
}

const catalogueWith = (adapter: ProviderAdapter): ModelCatalogue => ({
  providers: [{ id: adapter.id, label: adapter.label, cards: adapter.cards() }],
  catalog: CATALOG,
  cardFor: (ref) => findCard({ catalog: CATALOG, ref }),
  adapterFor: () => adapter,
  reachable: () => true,
  subscribed: () => false,
  observeAccounts: () => {},
})

describe('the model behind the switcher', () => {
  it('is not rebuilt when only the effort changes', () => {
    const adapter = new CountingAdapter()
    const selectable = selectableModel({
      initial: { ref: OPUS.ref, effort: EEffort.Low },
      catalogue: catalogueWith(adapter),
    })

    void selectable.model.provider
    selectable.select({ ref: OPUS.ref, effort: EEffort.High })
    selectable.select({ ref: OPUS.ref, effort: EEffort.XHigh })
    void selectable.model.provider

    expect(adapter.built).toEqual(['claude-opus-5'])
  })

  it('hands the adapter a thunk that reads the effort chosen since', () => {
    const adapter = new CountingAdapter()
    const selectable = selectableModel({
      initial: { ref: OPUS.ref, effort: EEffort.Low },
      catalogue: catalogueWith(adapter),
    })

    void selectable.model.provider
    expect(adapter.liveEffort?.()).toBe(EEffort.Low)

    selectable.select({ ref: OPUS.ref, effort: EEffort.XHigh })
    expect(adapter.liveEffort?.()).toBe(EEffort.XHigh)
  })

  it('does rebuild when the model itself changes', () => {
    const adapter = new CountingAdapter()
    const selectable = selectableModel({
      initial: { ref: OPUS.ref, effort: EEffort.Low },
      catalogue: catalogueWith(adapter),
    })

    void selectable.model.provider
    selectable.select({ ref: SONNET.ref, effort: EEffort.Low })
    void selectable.model.provider

    expect(adapter.built).toEqual(['claude-opus-5', 'claude-sonnet-5'])
  })
})

/**
 * What the composition root registers as `ModelCardSourceToken`. The port reads it per turn, so a
 * stale answer here is what silently zeroes the context window and disables auto-compact.
 */
describe('the card the model port is told to read', () => {
  it('names the window of whatever is answering right now', () => {
    const adapter = new CountingAdapter()
    const catalogue = catalogueWith(adapter)
    const selectable = selectableModel({
      initial: { ref: OPUS.ref, effort: EEffort.Low },
      catalogue,
    })

    const cardSource = () => catalogue.cardFor(selectable.choice().ref)

    expect(cardSource()?.contextWindow).toBe(1_000_000)

    selectable.select({ ref: SONNET.ref, effort: EEffort.Low })

    expect(cardSource()?.contextWindow).toBe(200_000)
  })

  it('still answers when only the effort moved, so the window does not blink out', () => {
    const adapter = new CountingAdapter()
    const catalogue = catalogueWith(adapter)
    const selectable = selectableModel({
      initial: { ref: OPUS.ref, effort: EEffort.Low },
      catalogue,
    })

    selectable.select({ ref: OPUS.ref, effort: EEffort.XHigh })

    expect(catalogue.cardFor(selectable.choice().ref)?.contextWindow).toBe(1_000_000)
  })
})
