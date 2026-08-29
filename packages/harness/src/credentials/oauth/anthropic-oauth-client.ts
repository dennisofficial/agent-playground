import { createHash, randomBytes } from 'node:crypto'

import type { ClockPort, OauthTokens } from '@dltech/atlas-core'

import { OauthHttpError, OauthResponseError } from './oauth-error'

// Claude.ai subscription OAuth: authorization code + PKCE (S256) with manual paste-back. Anthropic
// hosts a callback page that only displays `code#state`, so no local listening port is needed. The
// client id and URLs are public values carried by the Claude Code binary.
const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize'
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const REDIRECT_URL = 'https://platform.claude.com/oauth/code/callback'
const SCOPES = 'org:create_api_key user:profile user:inference'
const REQUEST_TIMEOUT_MS = 10_000
const FALLBACK_LIFETIME_SECONDS = 3600

export type Pkce = { verifier: string; challenge: string; state: string }

export type OauthLogin = {
  tokens: OauthTokens
  email?: string
  subscription?: string
}

type TokenFetch = (input: string, init: RequestInit) => Promise<Response>

const base64url = (bytes: Buffer): string => bytes.toString('base64url')

const stringOr = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

export class AnthropicOauthClient {
  private readonly clock: ClockPort
  private readonly fetch: TokenFetch

  constructor(args: { clock: ClockPort; fetch?: TokenFetch }) {
    this.clock = args.clock
    this.fetch = args.fetch ?? globalThis.fetch
  }

  generatePkce(): Pkce {
    const verifier = base64url(randomBytes(32))

    return {
      verifier,
      challenge: base64url(createHash('sha256').update(verifier).digest()),
      state: base64url(randomBytes(32)),
    }
  }

  authorizeUrl(pkce: Pkce): string {
    const url = new URL(AUTHORIZE_URL)
    url.searchParams.set('client_id', CLIENT_ID)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('redirect_uri', REDIRECT_URL)
    url.searchParams.set('scope', SCOPES)
    url.searchParams.set('code_challenge', pkce.challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', pkce.state)
    url.searchParams.set('code', 'true')

    return url.toString()
  }

  /** The operator pastes `code#state`; the fragment is a tamper check, not part of the code. */
  async exchange(args: { pasted: string; pkce: Pkce }): Promise<OauthLogin> {
    const [code, pastedState] = args.pasted.trim().split('#')

    if (pastedState !== undefined && pastedState !== args.pkce.state)
      throw new OauthResponseError('the pasted code carries a different state than the login began with')
    if (code === undefined || code.length === 0)
      throw new OauthResponseError('the pasted value holds no code')

    return this.post({
      grant_type: 'authorization_code',
      code,
      state: args.pkce.state,
      redirect_uri: REDIRECT_URL,
      client_id: CLIENT_ID,
      code_verifier: args.pkce.verifier,
    })
  }

  async refresh(args: { refreshToken: string }): Promise<OauthTokens> {
    const login = await this.post({
      grant_type: 'refresh_token',
      refresh_token: args.refreshToken,
      client_id: CLIENT_ID,
    })

    return login.tokens
  }

  private async post(body: Record<string, string>): Promise<OauthLogin> {
    const response = await this.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!response.ok) throw new OauthHttpError({ provider: 'Anthropic', status: response.status })

    return this.loginFrom(await response.json())
  }

  private loginFrom(raw: unknown): OauthLogin {
    const body = (raw ?? {}) as {
      access_token?: unknown
      refresh_token?: unknown
      expires_in?: unknown
      scope?: unknown
      subscription_type?: unknown
      account?: { subscription_type?: unknown; email_address?: unknown }
    }

    const accessToken = stringOr(body.access_token)
    const refreshToken = stringOr(body.refresh_token)
    if (accessToken === undefined || refreshToken === undefined)
      throw new OauthResponseError('it carries no access_token or no refresh_token')

    const lifetimeSeconds =
      typeof body.expires_in === 'number' ? body.expires_in : FALLBACK_LIFETIME_SECONDS
    const scope = stringOr(body.scope)
    const email = stringOr(body.account?.email_address)
    const subscription =
      stringOr(body.subscription_type) ?? stringOr(body.account?.subscription_type)

    return {
      tokens: {
        accessToken,
        refreshToken,
        expiresAt: new Date(Date.parse(this.clock.now()) + lifetimeSeconds * 1000).toISOString(),
        ...(scope === undefined ? {} : { scopes: scope.split(/\s+/).filter(Boolean) }),
      },
      ...(email === undefined ? {} : { email }),
      ...(subscription === undefined ? {} : { subscription }),
    }
  }
}
