import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'

import type { ClockPort } from '@dltech/atlas-core'

import { AnthropicOauthClient } from '../anthropic-oauth-client'
import { isHardAuthFailure, OauthHttpError, OauthResponseError } from '../oauth-error'

const NOW = '2026-01-01T00:00:00.000Z'

const clock: ClockPort = { now: () => NOW }

type Call = { url: string; body: unknown }

const clientAnswering = (args: {
  body?: unknown
  status?: number
}): { client: AnthropicOauthClient; calls: Call[] } => {
  const calls: Call[] = []

  const client = new AnthropicOauthClient({
    clock,
    fetch: async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as unknown })
      return new Response(JSON.stringify(args.body ?? {}), { status: args.status ?? 200 })
    },
  })

  return { client, calls }
}

const TOKEN_RESPONSE = {
  access_token: 'access-new',
  refresh_token: 'refresh-new',
  expires_in: 3600,
  scope: 'user:inference user:profile',
  account: { email_address: 'dev@example.com', subscription_type: 'max' },
}

describe('AnthropicOauthClient', () => {
  it('derives the challenge from the verifier by S256', () => {
    const { client } = clientAnswering({})
    const pkce = client.generatePkce()

    expect(pkce.challenge).toBe(createHash('sha256').update(pkce.verifier).digest('base64url'))
    expect(pkce.state).not.toBe(pkce.verifier)
  })

  it('asks for a code the operator can paste back', () => {
    const { client } = clientAnswering({})
    const pkce = client.generatePkce()

    const url = new URL(client.authorizeUrl(pkce))

    expect(url.origin + url.pathname).toBe('https://claude.com/cai/oauth/authorize')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe(pkce.challenge)
    expect(url.searchParams.get('state')).toBe(pkce.state)
    expect(url.searchParams.get('code')).toBe('true')
    expect(url.searchParams.get('scope')).toContain('user:inference')
  })

  it('exchanges the code and turns the lifetime into an instant', async () => {
    const { client, calls } = clientAnswering({ body: TOKEN_RESPONSE })
    const pkce = client.generatePkce()

    const login = await client.exchange({ pasted: `the-code#${pkce.state}`, pkce })

    expect(login.tokens).toEqual({
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
      expiresAt: '2026-01-01T01:00:00.000Z',
      scopes: ['user:inference', 'user:profile'],
    })
    expect(login.email).toBe('dev@example.com')
    expect(login.subscription).toBe('max')
    expect(calls[0]?.body).toMatchObject({
      grant_type: 'authorization_code',
      code: 'the-code',
      code_verifier: pkce.verifier,
    })
  })

  it('accepts a pasted code with no state fragment', async () => {
    const { client } = clientAnswering({ body: TOKEN_RESPONSE })
    const pkce = client.generatePkce()

    expect((await client.exchange({ pasted: '  the-code  ', pkce })).tokens.accessToken).toBe(
      'access-new',
    )
  })

  it('refuses a pasted code whose state is not the one the login began with', async () => {
    const { client, calls } = clientAnswering({ body: TOKEN_RESPONSE })
    const pkce = client.generatePkce()

    expect(client.exchange({ pasted: 'the-code#somebody-elses', pkce })).rejects.toThrow(
      OauthResponseError,
    )
    expect(calls).toHaveLength(0)
  })

  it('trades a refresh token for a rotated pair', async () => {
    const { client, calls } = clientAnswering({ body: TOKEN_RESPONSE })

    const tokens = await client.refresh({ refreshToken: 'refresh-old' })

    expect(tokens.refreshToken).toBe('refresh-new')
    expect(calls[0]?.body).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-old',
    })
  })

  it('defaults the lifetime when the server states none', async () => {
    const { client } = clientAnswering({ body: { access_token: 'a', refresh_token: 'r' } })

    expect((await client.refresh({ refreshToken: 'old' })).expiresAt).toBe(
      '2026-01-01T01:00:00.000Z',
    )
  })

  it('separates a dead credential from a blip, and quotes neither token', async () => {
    const dead = clientAnswering({ status: 400 })
    const blip = clientAnswering({ status: 503 })

    const deadError = await dead.client
      .refresh({ refreshToken: 'refresh-old' })
      .catch((error: unknown) => error)
    const blipError = await blip.client
      .refresh({ refreshToken: 'refresh-old' })
      .catch((error: unknown) => error)

    expect(deadError).toBeInstanceOf(OauthHttpError)
    expect(isHardAuthFailure(deadError)).toBe(true)
    expect(isHardAuthFailure(blipError)).toBe(false)
    expect(String(deadError)).not.toContain('refresh-old')
  })

  it('refuses a token response missing half the pair', async () => {
    const { client } = clientAnswering({ body: { access_token: 'only-access' } })

    expect(client.refresh({ refreshToken: 'old' })).rejects.toThrow(OauthResponseError)
  })
})
