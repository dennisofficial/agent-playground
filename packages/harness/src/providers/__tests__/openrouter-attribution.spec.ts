import { afterEach, describe, expect, it } from 'bun:test'

import {
  EAuthKind,
  EImageTier,
  type Credential,
  type CredentialPort,
  type EEffort,
  type ModelCard,
} from '@dltech/atlas-core'

import { OpenRouterAdapter, OPENROUTER_PROVIDER_ID } from '../openrouter-adapter'

const card: ModelCard = {
  ref: { providerId: OPENROUTER_PROVIDER_ID, modelId: 'a-model' },
  label: 'A model',
  api: 'openai-completions',
  contextWindow: 200_000,
  imageTier: EImageTier.Standard,
}

const credentials: CredentialPort = {
  read: async (): Promise<Credential> => ({
    kind: EAuthKind.ApiKey,
    accountId: 'acc_1' as Credential['accountId'],
    apiKey: 'k',
  }),
  discard: async () => undefined,
}

const effort = (): EEffort => 'medium' as EEffort

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('openrouter app attribution', () => {
  it('sends the referer and title headers so usage is not filed under Unknown', async () => {
    let sent: Headers | undefined
    const capturingFetch = async (_input: unknown, init?: RequestInit): Promise<Response> => {
      sent = new Headers(init?.headers)
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
        { headers: { 'content-type': 'application/json' } },
      )
    }
    globalThis.fetch = capturingFetch as typeof fetch

    const adapter = new OpenRouterAdapter({ credentials, cards: [card] })
    await adapter
      .model({ card, effort })
      .doGenerate({ prompt: [] } as never)

    expect(sent?.get('x-title')).toBe('Atlas')
    expect(sent?.get('http-referer')).toBe('https://github.com/dennisofficial/atlas')
  })
})
