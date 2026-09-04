import { createOpenAI, type OpenAIProviderSettings } from '@ai-sdk/openai'
import {
  APICallError,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type SharedV4ProviderOptions,
} from '@ai-sdk/provider'

import {
  EAuthKind,
  EAuthProvider,
  secretOf,
  type AccountId,
  type Credential,
  type CredentialPort,
} from '@dltech/atlas-core'

import { CredentialError, ECredentialFailure } from '../credentials/credential-error'

// A ChatGPT subscription token is only good against the codex backend, never api.openai.com. The
// transport is the Responses API under /backend-api/codex with the account id as a header and the
// request shaped the way codex shapes it (store off, encrypted reasoning content carried so a
// follow-up turn can thread it back). Constants verified against openai/codex `codex-rs`.
const CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api/codex'
const REFUSED_STATUSES = [401, 403]

const SUBSCRIPTION_REQUEST: SharedV4ProviderOptions = {
  openai: { store: false, include: ['reasoning.encrypted_content'] },
}

type AuthorizedModel = { model: LanguageModelV4; credential: Credential }

const wasRefused = (error: unknown): boolean =>
  APICallError.isInstance(error) && REFUSED_STATUSES.includes(error.statusCode ?? 0)

const settingsOf = (credential: Credential): OpenAIProviderSettings => {
  if (credential.kind === EAuthKind.ApiKey) return { apiKey: credential.apiKey }

  if (credential.providerAccountId === undefined)
    throw new CredentialError({
      failure: ECredentialFailure.Unreadable,
      message:
        'The OpenAI login Atlas holds carries no ChatGPT account id. Sign in again with /auth.',
    })

  return {
    apiKey: credential.accessToken,
    baseURL: CHATGPT_BASE_URL,
    headers: {
      'chatgpt-account-id': credential.providerAccountId,
      'OpenAI-Beta': 'responses=experimental',
      originator: 'codex_cli_rs',
    },
  }
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

export function createOpenAiModel(args: {
  credentials: CredentialPort
  providerId: string
  modelId: string
  accountId?: AccountId | undefined
  fetch?: OpenAIProviderSettings['fetch'] | undefined
}): LanguageModelV4 {
  const authorizedModel = async (): Promise<AuthorizedModel> => {
    const credential = await args.credentials.read({
      provider: EAuthProvider.OpenAI,
      accountId: args.accountId,
    })

    const model = createOpenAI({
      name: args.providerId,
      ...settingsOf(credential),
      ...(args.fetch === undefined ? {} : { fetch: args.fetch }),
    }).responses(args.modelId)

    return { model, credential }
  }

  // The codex request shape applies to a subscription; a metered api key must not carry it.
  const shaped = ({
    authorized,
    options,
  }: {
    authorized: AuthorizedModel
    options: LanguageModelV4CallOptions
  }): LanguageModelV4CallOptions => {
    if (authorized.credential.kind !== EAuthKind.Oauth) return options

    const providerOptions = mergedProviderOptions({
      defaults: SUBSCRIPTION_REQUEST,
      call: options.providerOptions,
    })

    if (providerOptions === undefined) return options
    return { ...options, providerOptions }
  }

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
    provider: args.providerId,
    modelId: args.modelId,
    supportedUrls: {},
    doGenerate: (options) =>
      throughACredentialTheServerAccepts((authorized) =>
        authorized.model.doGenerate(shaped({ authorized, options })),
      ),
    doStream: (options) =>
      throughACredentialTheServerAccepts((authorized) =>
        authorized.model.doStream(shaped({ authorized, options })),
      ),
  }
}
