import { describe, expect, it } from 'bun:test'
import { MockLanguageModelV4 } from 'ai/test'

import {
  ANTHROPIC_PROVIDER_ID,
  ATLAS_SETTINGS,
  EEffort,
  EImageTier,
  ESettingId,
  EUtilityModelRole,
  type ModelCard,
} from '@dltech/atlas-core'
import {
  AnthropicAdapter,
  cardsForProvider,
  createSettingsService,
  MemorySettingsStore,
  OpenAiAdapter,
  OPENAI_PROVIDER_ID,
  ProviderAdapter,
} from '@dltech/atlas-harness'

import {
  ENoticeTone,
  NOTICE_KEY_QUICK_MODEL_PREFIX,
  currentNotices,
  dismissNotice,
} from '../../ui/notice-store'
import { modelCatalogue } from '../providers'
import { createQuickModel } from '../quick-model'
import { alwaysAuthorised } from './fake-app'

const credentials = alwaysAuthorised()

const settingsService = () =>
  createSettingsService({ definitions: ATLAS_SETTINGS, user: new MemorySettingsStore() })

const shipped = () =>
  modelCatalogue({
    adapters: [
      new AnthropicAdapter({ credentials, cards: cardsForProvider(ANTHROPIC_PROVIDER_ID) }),
      new OpenAiAdapter({ credentials, cards: cardsForProvider(OPENAI_PROVIDER_ID) }),
    ],
  })

const FAKE_PROVIDER_ID = 'fake'

type FakeLanguageModel = ReturnType<ProviderAdapter['model']>

const failingModel = (): FakeLanguageModel =>
  new MockLanguageModelV4({
    provider: FAKE_PROVIDER_ID,
    modelId: 'fake-model',
    doGenerate: () => Promise.reject(new Error('boom')),
  })

const FAKE_CARD: ModelCard = {
  ref: { providerId: FAKE_PROVIDER_ID, modelId: 'fake-model' },
  label: 'Fake model',
  api: 'fake',
  contextWindow: 1000,
  imageTier: EImageTier.Standard,
}

class FakeAdapter extends ProviderAdapter {
  readonly id = FAKE_PROVIDER_ID
  readonly label = 'Fake'
  readonly efforts: EEffort[] = []

  private readonly inner: FakeLanguageModel

  constructor(args: { inner: FakeLanguageModel }) {
    super()
    this.inner = args.inner
  }

  cards(): readonly ModelCard[] {
    return [FAKE_CARD]
  }

  model(args: { card: ModelCard; effort: () => EEffort }): FakeLanguageModel {
    this.efforts.push(args.effort())
    return this.inner
  }

  effortOptions(): undefined {
    return undefined
  }
}

describe('the quick-tier model', () => {
  it('resolves the shipped quick default while nothing is set', () => {
    const quick = createQuickModel({
      role: EUtilityModelRole.Titler,
      settings: settingsService(),
      catalogue: shipped(),
    })

    expect(quick.modelId).toBe('claude-haiku-4-5-20251001')
    expect(quick.provider).toBe(ANTHROPIC_PROVIDER_ID)
  })

  it('follows a QuickModel settings change without being rebuilt', () => {
    const settings = settingsService()
    const quick = createQuickModel({
      role: EUtilityModelRole.Tldr,
      settings,
      catalogue: shipped(),
    })

    expect(quick.modelId).toBe('claude-haiku-4-5-20251001')

    const written = settings.set({ id: ESettingId.QuickModel, value: 'openai/gpt-5.1' })
    expect(written.ok).toBe(true)

    expect(quick.modelId).toBe('gpt-5.1')
    expect(quick.provider).toBe(OPENAI_PROVIDER_ID)
  })

  it('keeps the role default when the override names a model the catalogue does not carry', () => {
    const settings = settingsService()
    const quick = createQuickModel({
      role: EUtilityModelRole.Judge,
      settings,
      catalogue: shipped(),
    })

    const written = settings.set({ id: ESettingId.QuickModel, value: 'openai/not-a-real-model' })
    expect(written.ok).toBe(true)

    expect(quick.modelId).toBe('claude-haiku-4-5-20251001')
  })

  it('pins a low effort on the model it builds', async () => {
    const settings = settingsService()
    settings.set({ id: ESettingId.QuickModel, value: `${FAKE_PROVIDER_ID}/fake-model` })
    const adapter = new FakeAdapter({ inner: failingModel() })
    const quick = createQuickModel({
      role: EUtilityModelRole.Judge,
      settings,
      catalogue: modelCatalogue({ adapters: [adapter] }),
    })

    await expect(quick.doGenerate({ prompt: [] })).rejects.toThrow('boom')

    expect(adapter.efforts).toEqual([EEffort.Low])
    dismissNotice()
  })

  it('raises one keyed warn notice per provider when a quick call fails', async () => {
    const settings = settingsService()
    settings.set({ id: ESettingId.QuickModel, value: `${FAKE_PROVIDER_ID}/fake-model` })
    const adapter = new FakeAdapter({ inner: failingModel() })
    const quick = createQuickModel({
      role: EUtilityModelRole.Judge,
      settings,
      catalogue: modelCatalogue({ adapters: [adapter] }),
    })

    await expect(quick.doGenerate({ prompt: [] })).rejects.toThrow('boom')
    await expect(quick.doGenerate({ prompt: [] })).rejects.toThrow('boom')

    const raised = currentNotices().filter(
      (notice) => notice.key === `${NOTICE_KEY_QUICK_MODEL_PREFIX}:${FAKE_PROVIDER_ID}`,
    )
    expect(raised).toHaveLength(1)
    expect(raised[0]?.tone).toBe(ENoticeTone.Warn)
    expect(raised[0]?.text).toContain('judge')
    expect(raised[0]?.text).toContain(`${FAKE_PROVIDER_ID}/fake-model`)
    expect(raised[0]?.text).toContain('boom')
    dismissNotice()
  })
})
