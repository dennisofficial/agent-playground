import type { ClockPort, OauthTokens } from '@dltech/atlas-core'

import type { OauthLogin } from './anthropic-oauth-client'
import { EDevicePoll, type DeviceLogin, type DevicePoll } from './device-login'
import { decodeJwtClaims } from './jwt-claims'
import { OauthHttpError, OauthResponseError } from './oauth-error'

// ChatGPT subscription login via OpenAI's bespoke device-code flow — the one `codex login
// --device-auth` uses, NOT RFC 8628 (verified against openai/codex `codex-rs/login`):
//   1. POST /api/accounts/deviceauth/usercode {client_id} → {device_auth_id, user_code, interval}
//   2. poll POST /api/accounts/deviceauth/token {device_auth_id, user_code}: HTTP 403/404 = still
//      pending; HTTP 200 = {authorization_code, code_verifier} (server-generated PKCE)
//   3. exchange POST /oauth/token (form) grant_type=authorization_code → {id_token, access_token,
//      refresh_token}
// The verification URL and 15-minute expiry are client-constructed; the server returns neither.
// The client id is a public value carried by the codex binary.
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const USERCODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode'
const DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token'
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const DEVICE_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback'
const VERIFICATION_URL = 'https://auth.openai.com/codex/device'
const DEVICE_EXPIRES_IN_MS = 15 * 60 * 1000
const FALLBACK_LIFETIME_SECONDS = 3600
const REQUEST_TIMEOUT_MS = 10_000

type TokenFetch = (input: string, init: RequestInit) => Promise<Response>

type CodexTokens = { idToken: string; accessToken: string; refreshToken: string }

const stringOr = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const deviceNotEnabled = (): OauthResponseError =>
  new OauthResponseError(
    'device-code login is not enabled for this ChatGPT account. Enable "Sign in with device code" in ChatGPT security settings and press n to try again.',
  )

export class CodexOauthClient {
  private readonly clock: ClockPort
  private readonly fetch: TokenFetch

  constructor(args: { clock: ClockPort; fetch?: TokenFetch }) {
    this.clock = args.clock
    this.fetch = args.fetch ?? globalThis.fetch
  }

  async startDeviceLogin(): Promise<DeviceLogin> {
    const response = await this.post(USERCODE_URL, JSON.stringify({ client_id: CLIENT_ID }), {
      'content-type': 'application/json',
    })

    if (response.status === 404) throw deviceNotEnabled()
    if (!response.ok) throw new OauthHttpError({ provider: 'OpenAI', status: response.status })

    const body = (await response.json()) as {
      device_auth_id?: unknown
      user_code?: unknown
      usercode?: unknown
      interval?: unknown
    }

    const deviceAuthId = stringOr(body.device_auth_id)
    const userCode = stringOr(body.user_code) ?? stringOr(body.usercode)
    if (deviceAuthId === undefined || userCode === undefined)
      throw new OauthResponseError('it carries no device_auth_id or no user_code')

    // The poll interval arrives as either a number or a string ("0"); zero means "as fast as you like".
    const intervalRaw = typeof body.interval === 'string' ? Number(body.interval) : body.interval
    const intervalSeconds = typeof intervalRaw === 'number' && Number.isFinite(intervalRaw) ? intervalRaw : 5

    return {
      deviceAuthId,
      userCode,
      verificationUrl: VERIFICATION_URL,
      intervalMs: Math.max(intervalSeconds, 1) * 1000,
      expiresInMs: DEVICE_EXPIRES_IN_MS,
    }
  }

  async pollDeviceLogin(args: { deviceAuthId: string; userCode: string }): Promise<DevicePoll> {
    const response = await this.post(
      DEVICE_TOKEN_URL,
      JSON.stringify({ device_auth_id: args.deviceAuthId, user_code: args.userCode }),
      { 'content-type': 'application/json' },
    )

    if (response.status === 403 || response.status === 404) return { status: EDevicePoll.Pending }
    if (!response.ok) throw new OauthHttpError({ provider: 'OpenAI', status: response.status })

    const body = (await response.json()) as {
      authorization_code?: unknown
      code_verifier?: unknown
    }
    const authorizationCode = stringOr(body.authorization_code)
    const codeVerifier = stringOr(body.code_verifier)
    if (authorizationCode === undefined || codeVerifier === undefined)
      throw new OauthResponseError('it carries no authorization_code or no code_verifier')

    return {
      status: EDevicePoll.Complete,
      login: await this.exchangeCode({ authorizationCode, codeVerifier }),
    }
  }

  async refresh(args: { refreshToken: string }): Promise<OauthTokens> {
    const response = await this.post(
      OAUTH_TOKEN_URL,
      JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: args.refreshToken,
      }),
      { 'content-type': 'application/json' },
    )

    if (!response.ok) throw new OauthHttpError({ provider: 'OpenAI', status: response.status })

    const body = (await response.json()) as {
      id_token?: unknown
      access_token?: unknown
      refresh_token?: unknown
      expires_in?: unknown
    }

    const accessToken = stringOr(body.access_token)
    if (accessToken === undefined) throw new OauthResponseError('it carries no access_token')

    const idToken = stringOr(body.id_token)

    return {
      accessToken,
      refreshToken: stringOr(body.refresh_token) ?? args.refreshToken,
      expiresAt: this.expiryOf({ accessToken, expiresIn: body.expires_in }),
      ...accountIdFrom(idToken),
    }
  }

  private async exchangeCode(args: {
    authorizationCode: string
    codeVerifier: string
  }): Promise<OauthLogin> {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: args.authorizationCode,
      redirect_uri: DEVICE_REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: args.codeVerifier,
    })

    const response = await this.post(OAUTH_TOKEN_URL, form.toString(), {
      'content-type': 'application/x-www-form-urlencoded',
    })

    if (!response.ok) throw new OauthHttpError({ provider: 'OpenAI', status: response.status })

    const raw = (await response.json()) as {
      id_token?: unknown
      access_token?: unknown
      refresh_token?: unknown
      expires_in?: unknown
    }

    const idToken = stringOr(raw.id_token)
    const accessToken = stringOr(raw.access_token)
    const refreshToken = stringOr(raw.refresh_token)
    if (idToken === undefined || accessToken === undefined || refreshToken === undefined)
      throw new OauthResponseError('it carries no id_token, no access_token or no refresh_token')

    return this.loginFrom({ idToken, accessToken, refreshToken }, raw.expires_in)
  }

  private loginFrom(tokens: CodexTokens, expiresIn: unknown): OauthLogin {
    const claims = decodeJwtClaims(tokens.idToken)
    const email = stringOr(claims?.email) ?? stringOr(claims?.['https://api.openai.com/profile']?.email)
    const plan = stringOr(claims?.['https://api.openai.com/auth']?.chatgpt_plan_type)

    return {
      tokens: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: this.expiryOf({ accessToken: tokens.accessToken, expiresIn }),
        ...accountIdFrom(tokens.idToken),
      },
      ...(email === undefined ? {} : { email }),
      ...(plan === undefined ? {} : { subscription: plan }),
    }
  }

  /** The token endpoint omits expires_in on some responses; the access token's own exp is the fallback. */
  private expiryOf(args: { accessToken: string; expiresIn: unknown }): string {
    const nowMs = Date.parse(this.clock.now())

    if (typeof args.expiresIn === 'number' && Number.isFinite(args.expiresIn))
      return new Date(nowMs + args.expiresIn * 1000).toISOString()

    const exp = decodeJwtClaims(args.accessToken)?.exp
    if (typeof exp === 'number' && Number.isFinite(exp)) return new Date(exp * 1000).toISOString()

    return new Date(nowMs + FALLBACK_LIFETIME_SECONDS * 1000).toISOString()
  }

  private async post(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    return this.fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  }
}

const accountIdFrom = (idToken: string | undefined): { accountId: string } | Record<string, never> => {
  if (idToken === undefined) return {}

  const accountId = stringOr(
    decodeJwtClaims(idToken)?.['https://api.openai.com/auth']?.chatgpt_account_id,
  )

  return accountId === undefined ? {} : { accountId }
}
