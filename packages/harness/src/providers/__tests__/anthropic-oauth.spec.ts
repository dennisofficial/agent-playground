import { describe, expect, it } from 'bun:test'
import { generateText, streamText } from 'ai'

import { secretOf, type CredentialPort } from '@dltech/atlas-core'

import { CredentialError, ECredentialFailure } from '../../credentials'
import { apiKeyCredential, oauthCredential } from '../../credentials/testing'
import { ANTHROPIC_OAUTH_BETA, createAnthropicOauthModel } from '../anthropic-oauth'
import { generatedText, recordingFetch, refusingFirstFetch, streamedText } from './recording-fetch'

type Recording = CredentialPort & { readonly discarded: string[] }

const credentialsReturning = (...tokens: readonly string[]): Recording => {
  let handed = 0
  const discarded: string[] = []

  return {
    discarded,
    read: async () => {
      const accessToken = tokens[Math.min(handed, tokens.length - 1)] ?? ''
      handed += 1
      return oauthCredential({ accessToken })
    },
    discard: async (credential) => {
      discarded.push(secretOf(credential))
    },
  }
}

const apiKeyCredentials = (apiKey: string): CredentialPort => ({
  read: async () => apiKeyCredential({ apiKey }),
  discard: async () => {},
})

describe('the anthropic model authenticated by a subscription credential', () => {
  it('sends the credential as a bearer token under the oauth beta, and no api key', async () => {
    const recorder = recordingFetch({ body: streamedText('pong') })
    const model = createAnthropicOauthModel({
      credentials: credentialsReturning('token-one'),
      modelId: 'claude-opus-5',
      fetch: recorder.fetch,
    })

    const stream = streamText({ model, prompt: 'ping' })
    expect(await stream.text).toBe('pong')

    const request = recorder.requests[0]
    expect(recorder.requests).toHaveLength(1)
    expect(request?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(request?.headers.get('authorization')).toBe('Bearer token-one')
    expect(request?.headers.get('anthropic-version')).toBe('2023-06-01')
    expect(request?.headers.get('anthropic-beta')?.split(',')).toContain(ANTHROPIC_OAUTH_BETA)
    expect(request?.headers.has('x-api-key')).toBe(false)
  })

  it('prepends Atlas subscription attribution ahead of caller instructions', async () => {
    const recorder = recordingFetch({ body: streamedText('pong') })
    const model = createAnthropicOauthModel({
      credentials: credentialsReturning('token-one'),
      modelId: 'claude-sonnet-5',
      fetch: recorder.fetch,
    })

    await streamText({ model, system: 'You are Atlas.', prompt: 'ping' }).text

    expect(recorder.requests[0]?.body).toMatchObject({
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.261.6af; cc_entrypoint=atlas;',
        },
        { type: 'text', text: 'You are Atlas.' },
      ],
    })
  })

  it('fingerprints the first user text even when an assistant message precedes it', async () => {
    const recorder = recordingFetch({ body: streamedText('pong') })
    const model = createAnthropicOauthModel({
      credentials: credentialsReturning('token-one'),
      modelId: 'claude-sonnet-5',
      fetch: recorder.fetch,
    })

    await streamText({
      model,
      messages: [
        { role: 'assistant', content: 'Earlier reply.' },
        { role: 'user', content: 'what changed?' },
      ],
    }).text

    expect(recorder.requests[0]?.body).toMatchObject({
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.261.e1a; cc_entrypoint=atlas;',
        },
      ],
    })
  })

  it('attributes non-streaming generation through the same provider interface', async () => {
    const recorder = recordingFetch({
      body: generatedText('pong'),
      contentType: 'application/json',
    })
    const model = createAnthropicOauthModel({
      credentials: credentialsReturning('token-one'),
      modelId: 'claude-sonnet-5',
      fetch: recorder.fetch,
    })

    expect((await generateText({ model, prompt: 'ping' })).text).toBe('pong')
    expect(recorder.requests[0]?.body).toMatchObject({
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.261.6af; cc_entrypoint=atlas;',
        },
      ],
    })
  })

  it('reads the credential again for every request, so a refreshed token needs no rebuild', async () => {
    const recorder = recordingFetch({ body: streamedText('pong') })
    const model = createAnthropicOauthModel({
      credentials: credentialsReturning('token-before-refresh', 'token-after-refresh'),
      modelId: 'claude-opus-5',
      fetch: recorder.fetch,
    })

    await streamText({ model, prompt: 'first' }).text
    await streamText({ model, prompt: 'second' }).text

    expect(recorder.requests.map((request) => request.headers.get('authorization'))).toEqual([
      'Bearer token-before-refresh',
      'Bearer token-after-refresh',
    ])
  })

  it('ignores an api key sitting in the environment', async () => {
    const restore = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-not-ours'

    try {
      const recorder = recordingFetch({ body: streamedText('pong') })
      const model = createAnthropicOauthModel({
        credentials: credentialsReturning('token-one'),
        modelId: 'claude-opus-5',
        fetch: recorder.fetch,
      })

      await streamText({ model, prompt: 'ping' }).text

      expect(recorder.requests[0]?.headers.has('x-api-key')).toBe(false)
      expect(recorder.requests[0]?.headers.get('authorization')).toBe('Bearer token-one')
    } finally {
      if (restore === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = restore
    }
  })

  it('carries its default provider options onto the request body', async () => {
    const recorder = recordingFetch({ body: streamedText('pong') })
    const model = createAnthropicOauthModel({
      credentials: credentialsReturning('token-one'),
      modelId: 'claude-opus-5',
      providerOptions: { anthropic: { thinking: { type: 'adaptive', display: 'summarized' } } },
      fetch: recorder.fetch,
    })

    await streamText({ model, prompt: 'ping' }).text

    expect(recorder.requests[0]?.body).toMatchObject({
      thinking: { type: 'adaptive', display: 'summarized' },
    })
  })

  it('reads its provider options again per request, so a changed effort needs no rebuild', async () => {
    const recorder = recordingFetch({ body: streamedText('pong') })
    let effort = 'low'
    const model = createAnthropicOauthModel({
      credentials: credentialsReturning('token-one'),
      modelId: 'claude-opus-5',
      providerOptions: () => ({ anthropic: { effort } }),
      fetch: recorder.fetch,
    })

    await streamText({ model, prompt: 'ping' }).text
    effort = 'xhigh'
    await streamText({ model, prompt: 'ping' }).text

    expect(recorder.requests[0]?.body).toMatchObject({ output_config: { effort: 'low' } })
    expect(recorder.requests[1]?.body).toMatchObject({ output_config: { effort: 'xhigh' } })
  })

  it('sends an api key as an api key, not as a bearer token', async () => {
    const recorder = recordingFetch({ body: streamedText('pong') })
    const model = createAnthropicOauthModel({
      credentials: apiKeyCredentials('sk-ant-metered'),
      modelId: 'claude-opus-5',
      fetch: recorder.fetch,
    })

    await streamText({ model, prompt: 'ping' }).text

    expect(recorder.requests[0]?.headers.get('x-api-key')).toBe('sk-ant-metered')
    expect(recorder.requests[0]?.headers.has('authorization')).toBe(false)
  })

  it('keeps subscription attribution off a metered key, which needs no routing', async () => {
    const recorder = recordingFetch({ body: streamedText('pong') })
    const model = createAnthropicOauthModel({
      credentials: apiKeyCredentials('sk-ant-metered'),
      modelId: 'claude-sonnet-5',
      fetch: recorder.fetch,
    })

    await streamText({ model, system: 'You are Atlas.', prompt: 'ping' }).text

    expect(recorder.requests[0]?.body).toMatchObject({
      system: [{ type: 'text', text: 'You are Atlas.' }],
    })
  })

  it('takes up the live token and sends the call again when the server says revoked', async () => {
    const recorder = refusingFirstFetch({ body: streamedText('pong') })
    const credentials = credentialsReturning('revoked-token', 'live-token')
    const model = createAnthropicOauthModel({
      credentials,
      modelId: 'claude-opus-5',
      fetch: recorder.fetch,
    })

    expect(await streamText({ model, prompt: 'ping', maxRetries: 0 }).text).toBe('pong')

    expect(recorder.requests).toHaveLength(2)
    expect(recorder.requests[0]?.headers.get('authorization')).toBe('Bearer revoked-token')
    expect(recorder.requests[1]?.headers.get('authorization')).toBe('Bearer live-token')
    expect(credentials.discarded).toEqual(['revoked-token'])
  })

  it('takes up the live token on a generate call too', async () => {
    const recorder = refusingFirstFetch({
      body: generatedText('pong'),
      contentType: 'application/json',
    })
    const model = createAnthropicOauthModel({
      credentials: credentialsReturning('revoked-token', 'live-token'),
      modelId: 'claude-opus-5',
      fetch: recorder.fetch,
    })

    expect(await generateText({ model, prompt: 'ping', maxRetries: 0 }).then((r) => r.text)).toBe(
      'pong',
    )
    expect(recorder.requests).toHaveLength(2)
  })

  it('reports the refusal rather than sending the same refused token a second time', async () => {
    const recorder = refusingFirstFetch({ body: streamedText('pong') })
    const model = createAnthropicOauthModel({
      credentials: credentialsReturning('the-only-token'),
      modelId: 'claude-opus-5',
      fetch: recorder.fetch,
    })

    await expect(
      model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }] }),
    ).rejects.toThrow('OAuth access token has been revoked')
    expect(recorder.requests).toHaveLength(1)
  })

  it('fails the call with the credential failure and sends nothing when no credential is stored', async () => {
    const recorder = recordingFetch({ body: streamedText('pong') })
    const model = createAnthropicOauthModel({
      credentials: {
        read: () =>
          Promise.reject(
            new CredentialError({
              failure: ECredentialFailure.NotFound,
              message: 'no credential is stored',
            }),
          ),
        discard: async () => {},
      },
      modelId: 'claude-opus-5',
      fetch: recorder.fetch,
    })

    await expect(
      model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }] }),
    ).rejects.toThrow('no credential is stored')
    expect(recorder.requests).toHaveLength(0)
  })
})
