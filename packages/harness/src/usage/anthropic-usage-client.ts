import {
  AccountUsagePort,
  EAuthKind,
  type AccountUsage,
  type AccountUsageRequest,
  type CredentialPort,
} from '@dltech/atlas-core'

import { ANTHROPIC_OAUTH_BETA } from '../providers/anthropic-oauth'
import { parseAnthropicUsage } from './parse-anthropic-usage'

/**
 * The only source of a real 5-hour / 7-day percentage. Inference responses carry no rate-limit
 * headers even while this endpoint reports headroom, so nothing on the transport can stand in for
 * it. It needs the `user:profile` scope, which the login flow already requests, and it expects the
 * Claude Code CLI's user-agent — bump the version below if it starts refusing.
 */
export const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

const CLAUDE_CODE_VERSION = '2.1.251'

const REQUEST_TIMEOUT_MS = 10_000

export class AnthropicUsageClient extends AccountUsagePort {
  private readonly credentials: CredentialPort
  private readonly fetch: typeof globalThis.fetch

  constructor(args: { credentials: CredentialPort; fetch?: typeof globalThis.fetch }) {
    super()
    this.credentials = args.credentials
    this.fetch = args.fetch ?? globalThis.fetch
  }

  /** A meter is decoration: losing one must never take a turn, or opening a thread, down. */
  async read(request?: AccountUsageRequest): Promise<AccountUsage | null> {
    try {
      const credential = await this.credentials.read(
        request?.accountId === undefined ? undefined : { accountId: request.accountId },
      )
      if (credential.kind !== EAuthKind.Oauth) return null

      const response = await this.fetch(ANTHROPIC_USAGE_URL, {
        headers: {
          authorization: `Bearer ${credential.accessToken}`,
          'anthropic-beta': ANTHROPIC_OAUTH_BETA,
          'user-agent': `claude-code/${CLAUDE_CODE_VERSION}`,
          'content-type': 'application/json',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) return null

      return parseAnthropicUsage(await response.json())
    } catch {
      return null
    }
  }
}
