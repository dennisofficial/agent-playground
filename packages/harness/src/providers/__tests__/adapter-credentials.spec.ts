import { describe, expect, it } from 'bun:test'

import {
  EAuthKind,
  EAuthProvider,
  EImageTier,
  type Credential,
  type CredentialPort,
  type CredentialRequest,
  type EEffort,
  type ModelCard,
} from '@dltech/atlas-core'

import { OpenAiAdapter, OPENAI_PROVIDER_ID } from '../openai-adapter'
import { OpenRouterAdapter, OPENROUTER_PROVIDER_ID } from '../openrouter-adapter'

const cardOn = (providerId: string): ModelCard => ({
  ref: { providerId, modelId: 'a-model' },
  label: 'A model',
  api: 'openai-completions',
  contextWindow: 200_000,
  imageTier: EImageTier.Standard,
})

const asked: CredentialRequest[] = []

const credentials: CredentialPort = {
  read: async (request?: CredentialRequest): Promise<Credential> => {
    asked.push(request ?? {})
    return { kind: EAuthKind.ApiKey, accountId: 'acc_1' as Credential['accountId'], apiKey: 'k' }
  },
  discard: async () => undefined,
}

const effort = (): EEffort => 'medium' as EEffort

const withoutAKey: CredentialPort = {
  read: async (): Promise<Credential> => ({
    kind: EAuthKind.ApiKey,
    accountId: 'acc_1' as Credential['accountId'],
    apiKey: '',
  }),
  discard: async () => undefined,
}

describe('a provider adapter asking for a credential', () => {
  it('names the provider it needs, so the default is never handed to it', async () => {
    asked.length = 0
    const adapter = new OpenRouterAdapter({ credentials, cards: [cardOn(OPENROUTER_PROVIDER_ID)] })

    try {
      await adapter.model({ card: cardOn(OPENROUTER_PROVIDER_ID), effort }).doGenerate({} as never)
    } catch {
      // the request itself never leaves; only the credential it asked for matters here
    }

    expect(asked[0]?.provider).toBe(EAuthProvider.OpenRouter)
  })

  it('does the same for OpenAI, which shares the same fallback', async () => {
    asked.length = 0
    const adapter = new OpenAiAdapter({ credentials, cards: [cardOn(OPENAI_PROVIDER_ID)] })

    try {
      await adapter.model({ card: cardOn(OPENAI_PROVIDER_ID), effort }).doGenerate({} as never)
    } catch {
      // the request itself never leaves; only the credential it asked for matters here
    }

    expect(asked[0]?.provider).toBe(EAuthProvider.OpenAI)
  })

  it('names the account when the key is empty, rather than shipping a request without one', async () => {
    const adapter = new OpenRouterAdapter({
      credentials: withoutAKey,
      cards: [cardOn(OPENROUTER_PROVIDER_ID)],
    })

    let thrown: unknown
    try {
      await adapter.model({ card: cardOn(OPENROUTER_PROVIDER_ID), effort }).doGenerate({} as never)
    } catch (error) {
      thrown = error
    }

    expect((thrown as Error | undefined)?.message).toContain('OpenRouter account')
    expect((thrown as Error | undefined)?.message).toContain('carries no key')
  })
})
