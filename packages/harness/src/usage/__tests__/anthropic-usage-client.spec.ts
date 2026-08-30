import { describe, expect, it } from 'bun:test'
import {
  CredentialPort,
  EAuthKind,
  EUsageWindow,
  toAccountId,
  type Credential,
} from '@dltech/atlas-core'

import { ANTHROPIC_USAGE_URL, AnthropicUsageClient } from '../anthropic-usage-client'

const ACCOUNT = toAccountId('account-1')

const OAUTH: Credential = {
  kind: EAuthKind.Oauth,
  accountId: ACCOUNT,
  accessToken: 'access-token',
  expiresAt: '2099-01-01T00:00:00.000Z',
}

class StubCredentials extends CredentialPort {
  constructor(private readonly answer: () => Promise<Credential>) {
    super()
  }

  read(): Promise<Credential> {
    return this.answer()
  }
}

const respondingWith = (body: unknown, status = 200): typeof globalThis.fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch

const clientOf = (args: {
  fetch: typeof globalThis.fetch
  credential?: () => Promise<Credential>
}): AnthropicUsageClient =>
  new AnthropicUsageClient({
    credentials: new StubCredentials(args.credential ?? (async () => OAUTH)),
    fetch: args.fetch,
  })

describe('AnthropicUsageClient', () => {
  it('reads both windows for an account', async () => {
    const client = clientOf({
      fetch: respondingWith({
        five_hour: { utilization: 34, resets_at: '2026-08-29T19:30:00Z' },
        seven_day: { utilization: 61, resets_at: '2026-09-02T10:00:00Z' },
      }),
    })

    const usage = await client.read({ accountId: ACCOUNT })

    expect(usage?.[EUsageWindow.FiveHour]?.utilization).toBe(34)
    expect(usage?.[EUsageWindow.SevenDay]?.utilization).toBe(61)
  })

  it('presents the bearer token and the headers the endpoint expects', async () => {
    const seen: { url?: string; headers?: Record<string, string> } = {}
    const client = clientOf({
      fetch: (async (url: string, init: RequestInit) => {
        seen.url = url
        seen.headers = init.headers as Record<string, string>
        return new Response('{}', { status: 200 })
      }) as unknown as typeof globalThis.fetch,
    })

    await client.read({ accountId: ACCOUNT })

    expect(seen.url).toBe(ANTHROPIC_USAGE_URL)
    expect(seen.headers?.authorization).toBe('Bearer access-token')
    expect(seen.headers?.['anthropic-beta']).toContain('oauth')
    expect(seen.headers?.['user-agent']).toStartWith('claude-code/')
  })

  it('has nothing to report for an api key, which carries no subscription windows', async () => {
    const client = clientOf({
      fetch: respondingWith({ five_hour: { utilization: 34, resets_at: null } }),
      credential: async () => ({ kind: EAuthKind.ApiKey, accountId: ACCOUNT, apiKey: 'sk-x' }),
    })

    expect(await client.read({ accountId: ACCOUNT })).toBeNull()
  })

  it('goes quiet rather than failing when the endpoint refuses', async () => {
    const client = clientOf({ fetch: respondingWith({ error: 'nope' }, 401) })
    expect(await client.read({ accountId: ACCOUNT })).toBeNull()
  })

  it('goes quiet rather than failing when the request never lands', async () => {
    const client = clientOf({
      fetch: (async () => {
        throw new Error('socket hang up')
      }) as unknown as typeof globalThis.fetch,
    })
    expect(await client.read({ accountId: ACCOUNT })).toBeNull()
  })

  it('goes quiet rather than failing when the body is not json', async () => {
    const client = clientOf({
      fetch: (async () => new Response('&lt;html&gt;', { status: 200 })) as unknown as typeof globalThis.fetch,
    })
    expect(await client.read({ accountId: ACCOUNT })).toBeNull()
  })

  it('goes quiet rather than failing when there is no account to ask about', async () => {
    const client = clientOf({
      fetch: respondingWith({}),
      credential: async () => {
        throw new Error('no account')
      },
    })
    expect(await client.read({ accountId: ACCOUNT })).toBeNull()
  })
})
