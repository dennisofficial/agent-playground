import { describe, expect, it } from 'bun:test'
import { generateText } from 'ai'

import { secretOf, type CredentialPort } from '@dltech/atlas-core'

import { CredentialError } from '../../credentials'
import { apiKeyCredential, oauthCredential } from '../../credentials/testing'
import { createOpenAiModel } from '../openai-oauth'
import { recordingFetch, refusingFirstFetch } from './recording-fetch'

const RESPONSE_JSON = JSON.stringify({
  id: 'resp_stub',
  object: 'response',
  created_at: 1_767_225_600,
  status: 'completed',
  model: 'gpt-5.1-codex',
  output: [
    {
      type: 'message',
      id: 'msg_stub',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'pong', annotations: [] }],
    },
  ],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
})

const refusal = JSON.stringify({
  error: {
    message: 'invalid access token',
    type: 'invalid_request_error',
    param: null,
    code: 'invalid_api_key',
  },
})

const subscriptionCredentials = (...tokens: readonly string[]): CredentialPort & {
  readonly discarded: string[]
} => {
  let handed = 0
  const discarded: string[] = []

  return {
    discarded,
    read: async () =>
      oauthCredential({
        accessToken: tokens[Math.min(handed++, tokens.length - 1)] ?? '',
        providerAccountId: 'acct-123',
      }),
    discard: async (credential) => {
      discarded.push(secretOf(credential))
    },
  }
}

describe('the openai model authenticated by a ChatGPT subscription', () => {
  it('calls the codex backend with the account id as a header, never api.openai.com', async () => {
    const recorder = recordingFetch({ body: RESPONSE_JSON, contentType: 'application/json' })
    const model = createOpenAiModel({
      credentials: subscriptionCredentials('token-one'),
      providerId: 'openai',
      modelId: 'gpt-5.1-codex',
      fetch: recorder.fetch,
    })

    expect((await generateText({ model, prompt: 'ping' })).text).toBe('pong')

    const request = recorder.requests[0]
    expect(request?.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(request?.headers.get('authorization')).toBe('Bearer token-one')
    expect(request?.headers.get('chatgpt-account-id')).toBe('acct-123')
    expect(request?.headers.get('originator')).toBe('codex_cli_rs')
  })

  it('shapes the request the way the codex backend expects', async () => {
    const recorder = recordingFetch({ body: RESPONSE_JSON, contentType: 'application/json' })
    const model = createOpenAiModel({
      credentials: subscriptionCredentials('token-one'),
      providerId: 'openai',
      modelId: 'gpt-5.1-codex',
      fetch: recorder.fetch,
    })

    await generateText({ model, prompt: 'ping' })

    expect(recorder.requests[0]?.body).toMatchObject({
      store: false,
      include: ['reasoning.encrypted_content'],
    })
  })

  it('keeps caller provider options over the subscription defaults', async () => {
    const recorder = recordingFetch({ body: RESPONSE_JSON, contentType: 'application/json' })
    const model = createOpenAiModel({
      credentials: subscriptionCredentials('token-one'),
      providerId: 'openai',
      modelId: 'gpt-5.1-codex',
      fetch: recorder.fetch,
    })

    await generateText({
      model,
      prompt: 'ping',
      providerOptions: { openai: { reasoningEffort: 'high' } },
    })

    expect(recorder.requests[0]?.body).toMatchObject({
      store: false,
      reasoning: { effort: 'high' },
    })
  })

  it('discards a refused token and retries with the rotated pair', async () => {
    const recorder = refusingFirstFetch({
      body: RESPONSE_JSON,
      status: 401,
      contentType: 'application/json',
      refusalBody: refusal,
    })
    const credentials = subscriptionCredentials('token-revoked', 'token-rotated')
    const model = createOpenAiModel({
      credentials,
      providerId: 'openai',
      modelId: 'gpt-5.1-codex',
      fetch: recorder.fetch,
    })

    expect((await generateText({ model, prompt: 'ping' })).text).toBe('pong')

    expect(credentials.discarded).toEqual(['token-revoked'])
    expect(recorder.requests).toHaveLength(2)
    expect(recorder.requests[1]?.headers.get('authorization')).toBe('Bearer token-rotated')
  })

  it('refuses to send a subscription token with no account id anywhere', async () => {
    const recorder = recordingFetch({ body: RESPONSE_JSON, contentType: 'application/json' })
    const model = createOpenAiModel({
      credentials: {
        read: async () => oauthCredential({ accessToken: 'token-one' }),
        discard: async () => {},
      },
      providerId: 'openai',
      modelId: 'gpt-5.1-codex',
      fetch: recorder.fetch,
    })

    const failure = await generateText({ model, prompt: 'ping' }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(CredentialError)
    expect(String(failure)).toContain('account id')
    expect(recorder.requests).toHaveLength(0)
  })
})

describe('the openai model authenticated by an api key', () => {
  it('calls api.openai.com with the key and none of the codex shaping', async () => {
    const recorder = recordingFetch({ body: RESPONSE_JSON, contentType: 'application/json' })
    const model = createOpenAiModel({
      credentials: {
        read: async () => apiKeyCredential({ apiKey: 'sk-test' }),
        discard: async () => {},
      },
      providerId: 'openai',
      modelId: 'gpt-5.1-codex',
      fetch: recorder.fetch,
    })

    await generateText({ model, prompt: 'ping' })

    const request = recorder.requests[0]
    expect(request?.url).toBe('https://api.openai.com/v1/responses')
    expect(request?.headers.get('authorization')).toBe('Bearer sk-test')
    expect(request?.headers.has('chatgpt-account-id')).toBe(false)
    expect(request?.body).not.toMatchObject({ store: false })
  })
})
