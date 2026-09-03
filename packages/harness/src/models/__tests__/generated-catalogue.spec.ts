import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_IMAGE_TIER,
  EEffort,
  EFFORT_LADDER,
  EImageTier,
  findCard,
  parseRef,
  refKey,
  type ModelCard,
} from '@dltech/atlas-core'
import { API_BY_NPM, CATALOGUE_PROVIDER_IDS } from '../generated-card'
import {
  cardsForProvider,
  generatedCards,
  generatedCatalogue,
  GENERATED_MANIFEST,
  withoutDatedDuplicates,
} from '../generated-catalogue'

const catalogue = generatedCatalogue()
const cards = generatedCards()

const KNOWN_APIS = new Set(Object.values(API_BY_NPM))
const KNOWN_TIERS = new Set<string>(Object.values(EImageTier))
const KNOWN_RUNGS = new Set<string>(EFFORT_LADDER)
const BUDGET_RUNGS = new Set<string>([EEffort.Low, EEffort.Medium, EEffort.High])

const TIER = EImageTier.Standard

const budgetsOf = (card: ModelCard): readonly number[] =>
  Object.values(card.effort ?? {}).filter((wire): wire is number => typeof wire === 'number')

function cardFor(reference: string): ModelCard {
  const ref = parseRef(reference)
  if (ref === undefined) throw new Error(`${reference} is not a model ref`)

  const card = findCard({ catalog: catalogue, ref })
  if (card === undefined) throw new Error(`${reference} is missing from the generated catalogue`)
  return card
}

describe('generated catalogue', () => {
  it('loads every generated row as a card', () => {
    expect(cards.length).toBe(GENERATED_MANIFEST.modelCount)
    expect(catalogue.size).toBe(GENERATED_MANIFEST.modelCount)
    expect(GENERATED_MANIFEST.source).toBe('models.dev + api.inference.net')
    expect(GENERATED_MANIFEST.providerCount).toBe(CATALOGUE_PROVIDER_IDS.length)
  })

  it('memoizes so a render-time call is free', () => {
    expect(generatedCatalogue()).toBe(catalogue)
    expect(cardsForProvider('anthropic')).toBe(cardsForProvider('anthropic'))
  })

  it('slices the catalogue by provider without losing or duplicating a card', () => {
    const sliced = CATALOGUE_PROVIDER_IDS.flatMap((providerId) => cardsForProvider(providerId))
    expect(sliced.length).toBe(cards.length)

    for (const providerId of CATALOGUE_PROVIDER_IDS) {
      const slice = cardsForProvider(providerId)
      expect(slice.length).toBeGreaterThan(0)
      for (const card of slice) expect(card.ref.providerId).toBe(providerId)
    }
  })

  it('answers an unknown provider with an empty slice', () => {
    expect(cardsForProvider('nobody')).toEqual([])
  })

  it('keys every card by its own ref', () => {
    for (const [key, card] of catalogue) expect(key).toBe(refKey(card.ref))
  })

  it('holds only reachable providers and mapped apis', () => {
    for (const card of cards) {
      expect(CATALOGUE_PROVIDER_IDS).toContain(card.ref.providerId)
      expect(KNOWN_APIS.has(card.api)).toBe(true)
    }
  })

  it('gives every card a usable window, label and tier', () => {
    for (const card of cards) {
      expect(card.label.length).toBeGreaterThan(0)
      expect(card.contextWindow).toBeGreaterThan(0)
      expect(KNOWN_TIERS.has(card.imageTier)).toBe(true)
      if (card.maxOutputTokens !== undefined) expect(card.maxOutputTokens).toBeGreaterThan(0)
    }
  })

  it('never records an unknown price as free', () => {
    for (const card of cards) {
      if (card.cost === undefined) continue
      expect(Number.isFinite(card.cost.inputPerMillion)).toBe(true)
      expect(Number.isFinite(card.cost.outputPerMillion)).toBe(true)
    }
    expect(cards.some((card) => card.cost === undefined)).toBe(true)
  })

  it('only ever offers rungs from the ladder', () => {
    for (const card of cards) {
      if (card.effort === undefined) continue
      const rungs = Object.keys(card.effort)
      expect(rungs.length).toBeGreaterThan(0)
      for (const rung of rungs) expect(KNOWN_RUNGS.has(rung)).toBe(true)
    }
  })

  it('never mixes a literal and a budget in one ladder', () => {
    for (const card of cards) {
      if (card.effort === undefined) continue

      const kinds = new Set(Object.values(card.effort).map((wire) => typeof wire))
      expect(kinds.size).toBe(1)
    }
  })

  it('confines a budget ladder to low, medium and high with rising budgets', () => {
    const budgeted = cards.filter((card) => budgetsOf(card).length > 0)
    expect(budgeted.length).toBeGreaterThan(0)

    for (const card of budgeted) {
      for (const rung of Object.keys(card.effort ?? {})) expect(BUDGET_RUNGS.has(rung)).toBe(true)

      const budgets = budgetsOf(card)
      for (const budget of budgets) expect(budget).toBeGreaterThan(0)
      expect(budgets).toEqual([...budgets].sort((left, right) => left - right))
    }
  })

  it('reads anthropic opus-5 off models.dev without rescaling the price', () => {
    const card = cardFor('anthropic/claude-opus-5')
    expect(card.api).toBe('anthropic-messages')
    expect(card.contextWindow).toBe(1_000_000)
    expect(card.cost).toEqual({ inputPerMillion: 5, outputPerMillion: 25 })
    expect(card.effort?.[EEffort.High]).toBe('high')
    expect(card.effort?.[EEffort.Off]).toBeUndefined()
  })

  it('keeps the standard image tier the repo records for haiku, stamped or not', () => {
    expect(cardFor('anthropic/claude-haiku-4-5').imageTier).toBe(EImageTier.Standard)
    expect(cardFor('anthropic/claude-haiku-4-5-20251001').imageTier).toBe(EImageTier.Standard)
  })

  it('reserves the high-resolution tier for the models the repo records', () => {
    for (const modelId of [
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-fable-5-1',
    ]) {
      expect(cardFor(`anthropic/${modelId}`).imageTier).toBe(EImageTier.HighResolution)
    }

    expect(cardFor('anthropic/claude-opus-4-5').imageTier).toBe(DEFAULT_IMAGE_TIER)
    expect(cardFor('openrouter/z-ai/glm-4.6').imageTier).toBe(DEFAULT_IMAGE_TIER)
  })

  it('gives a budget-controlled model the scale the anthropic cards already use', () => {
    expect(cardFor('anthropic/claude-haiku-4-5').effort).toEqual({
      [EEffort.Low]: 1024,
      [EEffort.Medium]: 2048,
      [EEffort.High]: 16_384,
    })
  })

  it('prefers the effort literals when a model declares both controls', () => {
    expect(cardFor('anthropic/claude-opus-4-6').effort?.[EEffort.High]).toBe('high')
  })

  it('omits effort where reasoning is only a toggle', () => {
    expect(cardFor('openrouter/z-ai/glm-4.6').effort).toBeUndefined()
  })

  it("sends models.dev's none for the off rung", () => {
    const card = cardFor('openai/gpt-5.6')
    expect(card.api).toBe('openai-responses')
    expect(card.effort?.[EEffort.Off]).toBe('none')
    expect(card.effort?.[EEffort.Max]).toBe('max')
  })

  it('routes openrouter and inference through the openai-compatible api', () => {
    const routed = cards.filter(
      (card) => card.ref.providerId === 'openrouter' || card.ref.providerId === 'inference',
    )
    expect(routed.length).toBeGreaterThan(0)
    for (const card of routed) expect(card.api).toBe('openai-completions')
  })
})

const fakeCard = (reference: string): ModelCard => {
  const ref = parseRef(reference)
  if (ref === undefined) throw new Error(`${reference} is not a model ref`)

  return { ref, label: reference, api: 'openai-completions', contextWindow: 1, imageTier: TIER }
}

const referencesOf = (cards: readonly ModelCard[]): readonly string[] =>
  cards.map((card) => refKey(card.ref))

describe('withoutDatedDuplicates', () => {
  it('collapses the anthropic pairs onto the unstamped id', () => {
    const kept = referencesOf(withoutDatedDuplicates(cardsForProvider('anthropic')))

    for (const modelId of ['claude-haiku-4-5', 'claude-opus-4-5', 'claude-sonnet-4-5']) {
      expect(kept).toContain(`anthropic/${modelId}`)
    }
    for (const stamped of [
      'claude-haiku-4-5-20251001',
      'claude-opus-4-5-20251101',
      'claude-sonnet-4-5-20250929',
    ]) {
      expect(kept).not.toContain(`anthropic/${stamped}`)
    }
  })

  it("collapses openai's dash-punctuated snapshots too", () => {
    const kept = referencesOf(withoutDatedDuplicates(cardsForProvider('openai')))

    expect(kept).toContain('openai/gpt-4o')
    expect(kept).not.toContain('openai/gpt-4o-2024-08-06')
    expect(kept).not.toContain('openai/gpt-4o-2024-11-20')
  })

  it('keeps a stamped card that has no unstamped sibling', () => {
    const kept = referencesOf(withoutDatedDuplicates(cardsForProvider('openrouter')))
    expect(kept).toContain('openrouter/qwen/qwen3.5-plus-20260420')
  })

  it('never lets one provider shadow another', () => {
    const given = [
      fakeCard('anthropic/claude-x'),
      fakeCard('openrouter/anthropic/claude-x-20250101'),
    ]
    expect(referencesOf(withoutDatedDuplicates(given))).toEqual(referencesOf(given))
  })

  it('preserves input order and leaves the input untouched', () => {
    const given = [
      fakeCard('anthropic/claude-z'),
      fakeCard('anthropic/claude-y-20250101'),
      fakeCard('anthropic/claude-y'),
      fakeCard('anthropic/claude-a'),
    ]

    expect(referencesOf(withoutDatedDuplicates(given))).toEqual([
      'anthropic/claude-z',
      'anthropic/claude-y',
      'anthropic/claude-a',
    ])
    expect(given.length).toBe(4)
  })

  it('drops nothing from a list that has no stamped ids', () => {
    const given = [fakeCard('anthropic/claude-x'), fakeCard('openai/gpt-9')]
    expect(withoutDatedDuplicates(given)).toEqual(given)
  })

  it('leaves the catalogue itself able to resolve a stamped id', () => {
    expect(cardFor('anthropic/claude-haiku-4-5-20251001').imageTier).toBe(EImageTier.Standard)
    expect(catalogue.size).toBe(GENERATED_MANIFEST.modelCount)
  })
})
