import { createAnthropic, type AnthropicProviderSettings } from '@ai-sdk/anthropic'
import {
  APICallError,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type SharedV4ProviderOptions,
} from '@ai-sdk/provider'

import {
  ANTHROPIC_PROVIDER_ID,
  EAuthKind,
  secretOf,
  type AccountId,
  type Credential,
  type CredentialPort,
} from '@dltech/atlas-core'

import { withAnthropicSubscriptionAttribution } from './anthropic-subscription-attribution'

export type AnthropicFetch = NonNullable<AnthropicProviderSettings['fetch']>

export type AnthropicProviderOptions =
  | SharedV4ProviderOptions
  | (() => SharedV4ProviderOptions | undefined)

type AuthorizedModel = { model: LanguageModelV4; credential: Credential }

export const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20'
export { ANTHROPIC_PROVIDER_ID }

export type AnthropicOauthModelArgs = {
  credentials: CredentialPort
  modelId: string
  accountId?: AccountId | undefined
  providerOptions?: AnthropicProviderOptions | undefined
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

const heldProviderOptions = (
  held: AnthropicProviderOptions | undefined,
): SharedV4ProviderOptions | undefined => (typeof held === 'function' ? held() : held)

const REFUSED_STATUSES = [401, 403]

// A pair another holder of the same OAuth lineage has rotated away comes back as 401 "OAuth access
// token has been revoked." while its own `expiresAt` still reads fresh, so the server's refusal is
// the only signal that the pair is dead.
const wasRefused = (error: unknown): boolean =>
  APICallError.isInstance(error) && REFUSED_STATUSES.includes(error.statusCode ?? 0)

const authOf = (credential: Credential): AnthropicProviderSettings =>
  credential.kind === EAuthKind.Oauth
    ? { authToken: credential.accessToken, headers: { 'anthropic-beta': ANTHROPIC_OAUTH_BETA } }
    : { apiKey: credential.apiKey }

export function createAnthropicOauthModel(args: AnthropicOauthModelArgs): LanguageModelV4 {
  const authorizedModel = async (): Promise<AuthorizedModel> => {
    const credential = await args.credentials.read({ accountId: args.accountId })

    const model = createAnthropic({
      name: ANTHROPIC_PROVIDER_ID,
      ...authOf(credential),
      ...(args.baseURL === undefined ? {} : { baseURL: args.baseURL }),
      ...(args.fetch === undefined ? {} : { fetch: args.fetch }),
    })(args.modelId)

    return { model, credential }
  }

  const withDefaultProviderOptions = (
    options: LanguageModelV4CallOptions,
  ): LanguageModelV4CallOptions => {
    const providerOptions = mergedProviderOptions({
      defaults: heldProviderOptions(args.providerOptions),
      call: options.providerOptions,
    })

    if (providerOptions === undefined) return options
    return { ...options, providerOptions }
  }

  // The billing header routes a claude.ai subscription; a metered API key needs no routing and must
  // not carry it.
  const attributed = ({
    authorized,
    options,
  }: {
    authorized: AuthorizedModel
    options: LanguageModelV4CallOptions
  }): LanguageModelV4CallOptions =>
    authorized.credential.kind === EAuthKind.Oauth
      ? withAnthropicSubscriptionAttribution(withDefaultProviderOptions(options))
      : withDefaultProviderOptions(options)

  const throughACredentialTheServerAccepts = async <TResult>(
    call: (authorized: AuthorizedModel) => PromiseLike<TResult>,
  ): Promise<TResult> => {
    const authorized = await authorizedModel()

    try {
      return await call(authorized)
    } catch (error) {
      if (!wasRefused(error)) throw error

      await args.credentials.discard(authorized.credential)

      const retried = await authorizedModel()
      if (secretOf(retried.credential) === secretOf(authorized.credential)) throw error

      return await call(retried)
    }
  }

  return {
    specificationVersion: 'v4',
    provider: ANTHROPIC_PROVIDER_ID,
    modelId: args.modelId,
    supportedUrls: supportedUrlsWithoutACredential(args.modelId),

    doGenerate: (options) =>
      throughACredentialTheServerAccepts((authorized) =>
        authorized.model.doGenerate(attributed({ authorized, options })),
      ),

    doStream: (options) =>
      throughACredentialTheServerAccepts((authorized) =>
        authorized.model.doStream(attributed({ authorized, options })),
      ),
  }
}
