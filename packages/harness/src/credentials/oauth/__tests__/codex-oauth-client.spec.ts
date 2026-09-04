import { describe, expect, it } from 'bun:test'

import type { ClockPort } from '@dltech/atlas-core'

import { CodexOauthClient } from '../codex-oauth-client'
import { EDevicePoll } from '../device-login'
import { isHardAuthFailure, OauthHttpError, OauthResponseError } from '../oauth-error'

const NOW = '2026-01-01T00:00:00.000Z'

const clock: ClockPort = { now: () => NOW }

const jwt = (claims: Record<string, unknown>): string =>
  `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`

const ID_TOKEN = jwt({
  email: 'dennis@example.com',
  'https://api.openai.com/auth': {
    chatgpt_account_id: 'acct-123',
    chatgpt_plan_type: 'plus',
  },
})

const ACCESS_TOKEN = jwt({ exp: 1_767_225_600 })

const TOKEN_RESPONSE = {
  id_token: ID_TOKEN,
  access_token: ACCESS_TOKEN,
  refresh_token: 'refresh-1',
}

type Call = { url: string; body: string; contentType: string }

const clientScripted = (
  steps: readonly { status: number; body: unknown }[],
): { client: CodexOauthClient; calls: Call[] } => {
  const calls: Call[] = []
  let at = 0

  const client = new CodexOauthClient({
    clock,
    fetch: async (input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      calls.push({
        url: String(input),
        body: String(init?.body ?? ''),
        contentType: headers['content-type'] ?? '',
      })
      const step = steps[Math.min(at, steps.length - 1)]
      at += 1
      return new Response(JSON.stringify(step?.body ?? {}), { status: step?.status ?? 200 })
    },
  })

  return { client, calls }
}

describe('CodexOauthClient', () => {
  it('starts a device login with the public codex client id', async () => {
    const { client, calls } = clientScripted([
      { status: 200, body: { device_auth_id: 'da-1', user_code: 'ABCD-EFGH', interval: '0' } },
    ])

    const login = await client.startDeviceLogin()

    expect(calls[0]?.url).toBe('https://auth.openai.com/api/accounts/deviceauth/usercode')
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' })
    expect(login).toEqual({
      deviceAuthId: 'da-1',
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://auth.openai.com/codex/device',
      intervalMs: 1000,
      expiresInMs: 15 * 60 * 1000,
    })
  })

  it('takes the server poll interval when one is given', async () => {
    const { client } = clientScripted([
      { status: 200, body: { device_auth_id: 'da-1', user_code: 'ABCD', interval: 7 } },
    ])

    expect((await client.startDeviceLogin()).intervalMs).toBe(7000)
  })

  it('explains the ChatGPT setting when device login is not enabled for the account', async () => {
    const { client } = clientScripted([{ status: 404, body: {} }])

    const failure = await client.startDeviceLogin().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(OauthResponseError)
    expect(String(failure)).toContain('Sign in with device code')
  })

  it('reads 403 and 404 polls as still pending', async () => {
    const { client } = clientScripted([
      { status: 403, body: {} },
      { status: 404, body: {} },
    ])

    const ask = { deviceAuthId: 'da-1', userCode: 'ABCD' }

    expect(await client.pollDeviceLogin(ask)).toEqual({ status: EDevicePoll.Pending })
    expect(await client.pollDeviceLogin(ask)).toEqual({ status: EDevicePoll.Pending })
  })

  it('exchanges the polled code and names the account from the id token', async () => {
    const { client, calls } = clientScripted([
      { status: 200, body: { authorization_code: 'code-1', code_verifier: 'verifier-1' } },
      { status: 200, body: TOKEN_RESPONSE },
    ])

    const poll = await client.pollDeviceLogin({ deviceAuthId: 'da-1', userCode: 'ABCD' })

    expect(poll.status).toBe(EDevicePoll.Complete)
    if (poll.status !== EDevicePoll.Complete) return

    expect(poll.login.email).toBe('dennis@example.com')
    expect(poll.login.subscription).toBe('plus')
    expect(poll.login.tokens).toEqual({
      accessToken: ACCESS_TOKEN,
      refreshToken: 'refresh-1',
      expiresAt: new Date(1_767_225_600 * 1000).toISOString(),
      accountId: 'acct-123',
    })

    const exchange = calls[1]
    expect(exchange?.url).toBe('https://auth.openai.com/oauth/token')
    expect(exchange?.contentType).toBe('application/x-www-form-urlencoded')
    const form = new URLSearchParams(exchange?.body ?? '')
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('code-1')
    expect(form.get('code_verifier')).toBe('verifier-1')
    expect(form.get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback')
  })

  it('prefers expires_in over the token exp claim when both arrive', async () => {
    const { client } = clientScripted([
      { status: 200, body: { authorization_code: 'c', code_verifier: 'v' } },
      { status: 200, body: { ...TOKEN_RESPONSE, expires_in: 600 } },
    ])

    const poll = await client.pollDeviceLogin({ deviceAuthId: 'da-1', userCode: 'ABCD' })

    if (poll.status !== EDevicePoll.Complete) throw new Error('expected the login to complete')
    expect(poll.login.tokens.expiresAt).toBe('2026-01-01T00:10:00.000Z')
  })

  it('keeps the spent refresh token when the rotation answers without one', async () => {
    const { client } = clientScripted([
      { status: 200, body: { id_token: ID_TOKEN, access_token: ACCESS_TOKEN, expires_in: 300 } },
    ])

    const tokens = await client.refresh({ refreshToken: 'refresh-spent' })

    expect(tokens).toEqual({
      accessToken: ACCESS_TOKEN,
      refreshToken: 'refresh-spent',
      expiresAt: '2026-01-01T00:05:00.000Z',
      accountId: 'acct-123',
    })
  })

  it('separates a dead credential from a blip, and quotes neither token', async () => {
    const dead = clientScripted([{ status: 401, body: {} }])
    const blip = clientScripted([{ status: 503, body: {} }])

    const deadError = await dead.client
      .refresh({ refreshToken: 'refresh-secret' })
      .catch((error: unknown) => error)
    const blipError = await blip.client
      .refresh({ refreshToken: 'refresh-secret' })
      .catch((error: unknown) => error)

    expect(deadError).toBeInstanceOf(OauthHttpError)
    expect(isHardAuthFailure(deadError)).toBe(true)
    expect(isHardAuthFailure(blipError)).toBe(false)
    expect(String(deadError)).not.toContain('refresh-secret')
  })

  it('refuses a poll answer missing the code it promised', async () => {
    const { client } = clientScripted([{ status: 200, body: { authorization_code: 'only-code' } }])

    expect(
      client.pollDeviceLogin({ deviceAuthId: 'da-1', userCode: 'ABCD' }),
    ).rejects.toThrow(OauthResponseError)
  })
})
