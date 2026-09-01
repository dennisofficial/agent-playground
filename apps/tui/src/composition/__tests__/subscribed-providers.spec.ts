import { describe, expect, it } from 'bun:test'

import {
  ANTHROPIC_PROVIDER_ID,
  EAccountOrigin,
  EAccountStatus,
  EAuthKind,
  EAuthProvider,
  type Account,
  type AccountId,
} from '@dltech/atlas-core'
import {
  AnthropicAdapter,
  cardsForProvider,
  OpenRouterAdapter,
  OPENROUTER_PROVIDER_ID,
} from '@dltech/atlas-harness'

import { modelCatalogue } from '../providers'
import { alwaysAuthorised } from './fake-app'

const credentials = alwaysAuthorised()

const account = (args: { provider: EAuthProvider; kind: EAuthKind }): Account => ({
  id: `acc_${args.provider}` as AccountId,
  provider: args.provider,
  kind: args.kind,
  origin: EAccountOrigin.Login,
  label: `${args.provider} account`,
  status: EAccountStatus.Active,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

const catalogueWith = (accounts: readonly Account[]) =>
  modelCatalogue({
    adapters: [
      new AnthropicAdapter({ credentials, cards: cardsForProvider(ANTHROPIC_PROVIDER_ID) }),
      new OpenRouterAdapter({ credentials, cards: cardsForProvider(OPENROUTER_PROVIDER_ID) }),
    ],
    accounts,
  })

describe('which providers report a session and weekly window', () => {
  it('counts a plan, because the windows belong to the subscription', () => {
    const catalogue = catalogueWith([
      account({ provider: EAuthProvider.Anthropic, kind: EAuthKind.Oauth }),
    ])

    expect(catalogue.subscribed(ANTHROPIC_PROVIDER_ID)).toBe(true)
  })

  it('does not count a key on the same provider, which is billed per token', () => {
    const catalogue = catalogueWith([
      account({ provider: EAuthProvider.Anthropic, kind: EAuthKind.ApiKey }),
    ])

    expect(catalogue.subscribed(ANTHROPIC_PROVIDER_ID)).toBe(false)
  })

  it('does not count OpenRouter, which has no plan to meter', () => {
    const catalogue = catalogueWith([
      account({ provider: EAuthProvider.OpenRouter, kind: EAuthKind.ApiKey }),
      account({ provider: EAuthProvider.Anthropic, kind: EAuthKind.Oauth }),
    ])

    expect(catalogue.subscribed(OPENROUTER_PROVIDER_ID)).toBe(false)
    expect(catalogue.subscribed(ANTHROPIC_PROVIDER_ID)).toBe(true)
  })

  it('counts nothing before an account exists', () => {
    expect(catalogueWith([]).subscribed(ANTHROPIC_PROVIDER_ID)).toBe(false)
  })

  it('follows the accounts it is later told about', () => {
    const catalogue = catalogueWith([])
    catalogue.observeAccounts([
      account({ provider: EAuthProvider.Anthropic, kind: EAuthKind.Oauth }),
    ])

    expect(catalogue.subscribed(ANTHROPIC_PROVIDER_ID)).toBe(true)
  })
})
