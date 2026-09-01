import type { LanguageModelV4, SharedV4ProviderOptions } from '@ai-sdk/provider'

import {
  ANTHROPIC_PROVIDER_ID,
  type AccountId,
  type CredentialPort,
  type EEffort,
  type ModelCard,
} from '@dltech/atlas-core'

import { ProviderAdapter } from './adapter'
import { anthropicEffortOptions } from './anthropic-effort'
import { createAnthropicOauthModel } from './anthropic-oauth'

export class AnthropicAdapter extends ProviderAdapter {
  readonly id = ANTHROPIC_PROVIDER_ID
  readonly label = 'Claude Plan'

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
    return anthropicEffortOptions(args)
  }

  model(args: {
    card: ModelCard
    effort: () => EEffort
    accountId?: AccountId | undefined
  }): LanguageModelV4 {
    return createAnthropicOauthModel({
      credentials: this.credentials,
      modelId: args.card.ref.modelId,
      ...(args.accountId === undefined ? {} : { accountId: args.accountId }),
      providerOptions: () => this.effortOptions({ card: args.card, effort: args.effort() }),
    })
  }
}
