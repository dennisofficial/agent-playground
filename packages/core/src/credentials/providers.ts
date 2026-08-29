import { EAuthKind, EAuthProvider } from './account'

export enum ELoginFlow {
  PastedCode = 'pasted-code',
  DeviceCode = 'device-code',
  ApiKey = 'api-key',
}

export type ProviderSpec = {
  provider: EAuthProvider
  label: string
  kinds: readonly EAuthKind[]
  logins: readonly ELoginFlow[]
  apiKeyVariable?: string
  reachable: boolean
}

export const PROVIDER_SPECS: readonly ProviderSpec[] = [
  {
    provider: EAuthProvider.Anthropic,
    label: 'Anthropic',
    kinds: [EAuthKind.Oauth, EAuthKind.ApiKey],
    logins: [ELoginFlow.PastedCode, ELoginFlow.ApiKey],
    apiKeyVariable: 'ANTHROPIC_API_KEY',
    reachable: true,
  },
  {
    provider: EAuthProvider.OpenAI,
    label: 'OpenAI',
    kinds: [EAuthKind.Oauth, EAuthKind.ApiKey],
    logins: [ELoginFlow.DeviceCode, ELoginFlow.ApiKey],
    apiKeyVariable: 'OPENAI_API_KEY',
    reachable: false,
  },
  {
    provider: EAuthProvider.OpenRouter,
    label: 'OpenRouter',
    kinds: [EAuthKind.ApiKey],
    logins: [ELoginFlow.ApiKey],
    apiKeyVariable: 'OPENROUTER_API_KEY',
    reachable: false,
  },
]

export const providerSpec = (provider: EAuthProvider): ProviderSpec => {
  const found = PROVIDER_SPECS.find((spec) => spec.provider === provider)
  if (found === undefined) throw new Error(`no provider spec for ${provider}`)
  return found
}

export const reachableProviders = (): readonly ProviderSpec[] =>
  PROVIDER_SPECS.filter((spec) => spec.reachable)
