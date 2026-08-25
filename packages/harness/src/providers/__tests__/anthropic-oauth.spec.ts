import { describe, expect, it } from 'bun:test'
import { streamText } from 'ai'

import type { Credential, CredentialPort } from '@dltech/atlas-core'

import { CredentialError, ECredentialFailure } from '../../credentials'
import { ANTHROPIC_OAUTH_BETA, createAnthropicOauthModel } from '../anthropic-oauth'
import { recordingFetch, streamedText } from './recording-fetch'

const inAnHour = (): string => new Date(Date.now() + 3_600_000).toISOString()

const credentialsReturning = (...tokens: readonly string[]): CredentialPort => {
  let handed = 0
  return {
    read: async (): Promise<Credential> => {
      const accessToken = tokens[Math.min(handed, tokens.length - 1)] ?? ''
      handed += 1
      return { accessToken, expiresAt: inAnHour() }
    },
  }
}

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
