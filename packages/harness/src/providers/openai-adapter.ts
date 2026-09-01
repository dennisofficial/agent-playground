import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModelV4, SharedV4ProviderOptions } from '@ai-sdk/provider'

import {
  EAuthProvider,
  type AccountId,
  type CredentialPort,
  type EEffort,
  type ModelCard,
} from '@dltech/atlas-core'

import { ProviderAdapter } from './adapter'
import { providerKey } from './provider-key'
import { openaiEffortOptions } from './openai-effort'

export const OPENAI_PROVIDER_ID = 'openai'

export class OpenAiAdapter extends ProviderAdapter {
  readonly id = OPENAI_PROVIDER_ID
  readonly label = 'Codex Plan'

  private readonly credentials: CredentialPort
  private readonly catalogue: readonly ModelCard[]

  constructor(args: { credentials: CredentialPort; cards: readonly ModelCard[] }) {
    super()
    this.credentials = args.credentials
    this.catalogue = args.cards
  }

  cards(): readonly ModelCard[] {
    return this.catalogue
  }

  effortOptions(args: { card: ModelCard; effort: EEffort }): SharedV4ProviderOptions | undefined {
    return openaiEffortOptions(args)
  }

  model(args: {
    card: ModelCard
    effort: () => EEffort
    accountId?: AccountId | undefined
  }): LanguageModelV4 {
    const authorized = async (): Promise<LanguageModelV4> => {
      const credential = await this.credentials.read({
        provider: EAuthProvider.OpenAI,
        accountId: args.accountId,
      })
      const apiKey = providerKey({ credential, label: this.label })

      return createOpenAI({ name: OPENAI_PROVIDER_ID, apiKey }).responses(args.card.ref.modelId)
    }

    const withEffort = (options: Parameters<LanguageModelV4['doStream']>[0]) => {
      const effort = this.effortOptions({ card: args.card, effort: args.effort() })
      if (effort === undefined) return options
      return { ...options, providerOptions: { ...effort, ...options.providerOptions } }
    }

    return {
      specificationVersion: 'v4',
      provider: OPENAI_PROVIDER_ID,
      modelId: args.card.ref.modelId,
      supportedUrls: {},
      doGenerate: async (options) => (await authorized()).doGenerate(withEffort(options)),
      doStream: async (options) => (await authorized()).doStream(withEffort(options)),
    }
  }
}
