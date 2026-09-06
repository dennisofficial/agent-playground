import {
  ANTHROPIC_PROVIDER_ID,
  catalogOf,
  EAuthKind,
  findCard,
  reachableProviders,
  refKey,
  type Account,
  type CredentialPort,
  type ModelCard,
  type ModelCatalog,
  type ModelRef,
} from '@dltech/atlas-core'
import {
  AnthropicAdapter,
  cardsForProvider,
  INFERENCE_PROVIDER_ID,
  InferenceAdapter,
  OPENAI_PROVIDER_ID,
  OPENROUTER_PROVIDER_ID,
  OpenAiAdapter,
  OpenRouterAdapter,
  withoutDatedDuplicates,
  type ProviderAdapter,
} from '@dltech/atlas-harness'

import type { SwitcherProvider } from '../ui/switcher-model'

export type ModelCatalogue = {
  providers: readonly SwitcherProvider[]
  catalog: ModelCatalog
  cardFor: (ref: ModelRef) => ModelCard | undefined
  adapterFor: (providerId: string) => ProviderAdapter | undefined
  reachable: (providerId: string) => boolean
  subscribed: (providerId: string) => boolean
  observeAccounts: (accounts: readonly Account[]) => void
}

const providersHolding = (args: {
  accounts: readonly Account[]
  wanted: (account: Account) => boolean
}): ReadonlySet<string> =>
  new Set(
    reachableProviders()
      .filter((spec) =>
        args.accounts.some((account) => account.provider === spec.provider && args.wanted(account)),
      )
      .map((spec) => String(spec.provider)),
  )

const keyedProviders = (accounts: readonly Account[]): ReadonlySet<string> =>
  providersHolding({ accounts, wanted: () => true })

/**
 * A five-hour and a weekly window are what a plan meters. A key on the same provider is billed per
 * token and reports neither, so a footer that showed them would be drawing somebody else's numbers.
 */
const subscribedProviders = (accounts: readonly Account[]): ReadonlySet<string> =>
  providersHolding({ accounts, wanted: (account) => account.kind === EAuthKind.Oauth })

export function modelCatalogue(args: {
  adapters: readonly ProviderAdapter[]
  accounts?: readonly Account[]
}): ModelCatalogue {
  const cards = args.adapters.flatMap((adapter) => [...adapter.cards()])
  const catalog = catalogOf(cards)
  let keyed = keyedProviders(args.accounts ?? [])
  let subscribed = subscribedProviders(args.accounts ?? [])

  return {
    providers: args.adapters.map((adapter) => ({
      id: adapter.id,
      label: adapter.label,
      cards: withoutDatedDuplicates(adapter.cards()),
    })),
    catalog,
    cardFor: (ref) => findCard({ catalog, ref }),
    adapterFor: (providerId) => args.adapters.find((adapter) => adapter.id === providerId),
    reachable: (providerId) => keyed.has(providerId),
    subscribed: (providerId) => subscribed.has(providerId),
    observeAccounts: (accounts) => {
      keyed = keyedProviders(accounts)
      subscribed = subscribedProviders(accounts)
    },
  }
}

export const providerAdapters = (args: {
  credentials: CredentialPort
}): readonly ProviderAdapter[] => [
  new AnthropicAdapter({
    credentials: args.credentials,
    cards: cardsForProvider(ANTHROPIC_PROVIDER_ID),
  }),
  new OpenAiAdapter({ credentials: args.credentials, cards: cardsForProvider(OPENAI_PROVIDER_ID) }),
  new OpenRouterAdapter({
    credentials: args.credentials,
    cards: cardsForProvider(OPENROUTER_PROVIDER_ID),
  }),
  new InferenceAdapter({
    credentials: args.credentials,
    cards: cardsForProvider(INFERENCE_PROVIDER_ID),
  }),
]

export const unanswerableRef = (key: string): Error =>
  new Error(`no provider adapter can answer for ${key}`)

export const isRefReachable = (args: { catalogue: ModelCatalogue; ref: ModelRef }): boolean =>
  args.catalogue.cardFor(args.ref) !== undefined && args.catalogue.reachable(args.ref.providerId)

/**
 * The window the model port reads comes from this card. With no card `contextWindowOf` answers
 * `CONTEXT_WINDOW_UNMEASURED`, which `autoCompactBeforeStep` reads as "hold" — so auto-compact and
 * the context meter both stop without anything failing. Worth saying out loud once.
 */
export const unmeasuredWindowWarning = (args: {
  catalogue: ModelCatalogue
  ref: ModelRef
}): string | null =>
  args.catalogue.cardFor(args.ref) === undefined
    ? `Auto-compact and the context meter are off — no context window known for ${refKey(args.ref)}.`
    : null

export const catalogueLabel = (args: { catalogue: ModelCatalogue; ref: ModelRef }): string =>
  args.catalogue.cardFor(args.ref)?.label ?? args.ref.modelId

export const knownRefs = (catalogue: ModelCatalogue): readonly string[] =>
  [...catalogue.catalog.values()].map((card) => refKey(card.ref))
