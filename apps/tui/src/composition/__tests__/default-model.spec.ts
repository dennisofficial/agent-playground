import { describe, expect, it } from 'bun:test'

import {
  ANTHROPIC_PROVIDER_ID,
  ATLAS_SETTINGS,
  CONTEXT_WINDOW_UNMEASURED,
  refKey,
} from '@dltech/atlas-core'
import {
  AnthropicAdapter,
  cardsForProvider,
  createSettingsService,
  MemorySettingsStore,
  OpenAiAdapter,
  OPENAI_PROVIDER_ID,
} from '@dltech/atlas-harness'

import { DEFAULT_MODEL_REF } from '../config'
import { launchSelection } from '../model-preference'
import { modelCatalogue, unmeasuredWindowWarning } from '../providers'
import { alwaysAuthorised } from './fake-app'

const credentials = alwaysAuthorised()

const shipped = () =>
  modelCatalogue({
    adapters: [
      new AnthropicAdapter({ credentials, cards: cardsForProvider(ANTHROPIC_PROVIDER_ID) }),
      new OpenAiAdapter({ credentials, cards: cardsForProvider(OPENAI_PROVIDER_ID) }),
    ],
  })

const nothingRemembered = createSettingsService({
  definitions: ATLAS_SETTINGS,
  user: new MemorySettingsStore(),
}).snapshot().resolution

/**
 * `ModelCardSourceToken` hands the port `models.cardFor(model.choice().ref)`. If that ever answers
 * undefined the window reads `CONTEXT_WINDOW_UNMEASURED`, which `autoCompactBeforeStep` treats as
 * "hold" — so auto-compact and the context meter both go quiet without anything failing. Nothing
 * else pins the shipped catalogue to the ref Atlas actually launches on.
 */
describe('the model Atlas launches on', () => {
  it('is a card the shipped catalogue can resolve', () => {
    const card = shipped().cardFor(DEFAULT_MODEL_REF)
    expect(card).toBeDefined()
    expect(refKey(card?.ref ?? DEFAULT_MODEL_REF)).toBe(refKey(DEFAULT_MODEL_REF))
  })

  it('reports a measured context window, so auto-compact has a ceiling to work against', () => {
    const window = shipped().cardFor(DEFAULT_MODEL_REF)?.contextWindow ?? CONTEXT_WINDOW_UNMEASURED
    expect(window).toBeGreaterThan(CONTEXT_WINDOW_UNMEASURED)
  })

  it('is what a launch with nothing remembered settles on', () => {
    const catalogue = shipped()
    const selection = launchSelection({
      requested: { model: undefined },
      settled: nothingRemembered,
      catalogue,
    })

    expect(refKey(selection.ref)).toBe(refKey(DEFAULT_MODEL_REF))
    expect(
      catalogue.cardFor(selection.ref)?.contextWindow ?? CONTEXT_WINDOW_UNMEASURED,
    ).toBeGreaterThan(CONTEXT_WINDOW_UNMEASURED)
  })
})

describe('warning that the window is unmeasured', () => {
  it('says nothing while the launch model resolves to a card', () => {
    expect(unmeasuredWindowWarning({ catalogue: shipped(), ref: DEFAULT_MODEL_REF })).toBeNull()
  })

  it('leads with what stopped working, and names the ref that caused it', () => {
    const warning = unmeasuredWindowWarning({
      catalogue: shipped(),
      ref: { providerId: 'anthropic', modelId: 'not-a-model' },
    })

    expect(warning).toContain('Auto-compact and the context meter are off')
    expect(warning).toContain('anthropic/not-a-model')
    expect(warning?.indexOf('Auto-compact')).toBeLessThan(
      warning?.indexOf('no context window') ?? 0,
    )
  })
})
