import { createAnthropic, type AnthropicProviderSettings } from '@ai-sdk/anthropic'
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  SharedV4ProviderOptions,
} from '@ai-sdk/provider'

import { ANTHROPIC_PROVIDER_ID, type CredentialPort } from '@dltech/atlas-core'

import { withAnthropicSubscriptionAttribution } from './anthropic-subscription-attribution'

export type AnthropicFetch = NonNullable<AnthropicProviderSettings['fetch']>

export const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20'
export { ANTHROPIC_PROVIDER_ID }

export type AnthropicOauthModelArgs = {
  credentials: CredentialPort
  modelId: string
  providerOptions?: SharedV4ProviderOptions | undefined
  baseURL?: string | undefined
  fetch?: AnthropicFetch | undefined
}

const mergedProviderOptions = (args: {
  defaults: SharedV4ProviderOptions | undefined
  call: SharedV4ProviderOptions | undefined
}): SharedV4ProviderOptions | undefined => {
  if (args.defaults === undefined) return args.call
  if (args.call === undefined) return args.defaults

  const merged: SharedV4ProviderOptions = { ...args.defaults }
  for (const [namespace, values] of Object.entries(args.call)) {
    merged[namespace] = { ...merged[namespace], ...values }
  }
  return merged
}

// @ai-sdk/anthropic 4.0.41 resolves auth headers lazily, per request, so a provider built with no
// credential is legal as long as no request is made through it. `supportedUrls` reads pure config.
const supportedUrlsWithoutACredential = (modelId: string) => createAnthropic()(modelId).supportedUrls

export function createAnthropicOauthModel(args: AnthropicOauthModelArgs): LanguageModelV4 {
  const authorizedModel = async (): Promise<LanguageModelV4> => {
    const credential = await args.credentials.read()

    return createAnthropic({
      name: ANTHROPIC_PROVIDER_ID,
      authToken: credential.accessToken,
      headers: { 'anthropic-beta': ANTHROPIC_OAUTH_BETA },
      ...(args.baseURL === undefined ? {} : { baseURL: args.baseURL }),
      ...(args.fetch === undefined ? {} : { fetch: args.fetch }),
    })(args.modelId)
  }

  const withDefaultProviderOptions = (
    options: LanguageModelV4CallOptions,
  ): LanguageModelV4CallOptions => {
    const providerOptions = mergedProviderOptions({
      defaults: args.providerOptions,
      call: options.providerOptions,
    })

    if (providerOptions === undefined) return options
    return { ...options, providerOptions }
  }

  return {
    specificationVersion: 'v4',
    provider: ANTHROPIC_PROVIDER_ID,
    modelId: args.modelId,
    supportedUrls: supportedUrlsWithoutACredential(args.modelId),

    doGenerate: async (options) =>
      (await authorizedModel()).doGenerate(
        withAnthropicSubscriptionAttribution(withDefaultProviderOptions(options)),
      ),

    doStream: async (options) =>
      (await authorizedModel()).doStream(
        withAnthropicSubscriptionAttribution(withDefaultProviderOptions(options)),
      ),
  }
}
