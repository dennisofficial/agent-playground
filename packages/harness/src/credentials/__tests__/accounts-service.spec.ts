import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { EAccountOrigin, EAuthKind, EAuthProvider } from '@dltech/atlas-core'

import { AccountsService } from '../accounts-service'
import { CredentialError, ECredentialFailure } from '../credential-error'
import { AnthropicOauthClient, type OauthClients } from '../oauth'
import { movableClock, oauthSecret, openVault, type Vault } from './vault-fixture'

const TOKEN_RESPONSE = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_in: 3600,
  account: { email_address: 'dev@example.com', subscription_type: 'max' },
}

let vault: Vault
let clock = movableClock()

const clientsAnswering = (body: unknown): OauthClients => ({
  [EAuthProvider.Anthropic]: new AnthropicOauthClient({
    clock,
    fetch: async () => new Response(JSON.stringify(body), { status: 200 }),
  }),
})

const serviceWith = (body: unknown = TOKEN_RESPONSE): AccountsService =>
  new AccountsService({ accounts: vault.store, clients: clientsAnswering(body) })

beforeEach(() => {
  clock = movableClock()
  vault = openVault(clock)
})

afterEach(() => {
  vault.close()
})

describe('AccountsService', () => {
  it('signs in, names the account after the operator and makes it the one that answers', async () => {
    const service = serviceWith()
    const ticket = service.begin(EAuthProvider.Anthropic)

    const account = await service.complete({ ticket, pasted: `code#${ticket.pkce.state}` })

    expect(account.label).toBe('dev@example.com')
    expect(account.subscription).toBe('max')
    expect(account.origin).toBe(EAccountOrigin.Login)
    expect(await service.activeFor(EAuthProvider.Anthropic)).toBe(account.id)
  })

  it('hands the operator a URL carrying the challenge it will verify', async () => {
    const ticket = serviceWith().begin(EAuthProvider.Anthropic)

    expect(new URL(ticket.url).searchParams.get('code_challenge')).toBe(ticket.pkce.challenge)
  })

  it('falls back to the provider and plan when the login carries no email', async () => {
    const service = serviceWith({ access_token: 'a', refresh_token: 'r', subscription_type: 'pro' })
    const ticket = service.begin(EAuthProvider.Anthropic)

    expect((await service.complete({ ticket, pasted: 'code' })).label).toBe('Anthropic (pro)')
  })

  it('refuses to begin a login for a provider Atlas cannot sign in to yet', () => {
    expect(() => serviceWith().begin(EAuthProvider.OpenRouter)).toThrow(CredentialError)
  })

  it('takes an api key for a provider that has no login flow wired', async () => {
    const account = await serviceWith().addApiKey({
      provider: EAuthProvider.OpenRouter,
      apiKey: '  or-key  ',
    })

    expect(account.kind).toBe(EAuthKind.ApiKey)
    expect((await vault.store.read(account.id))?.secret).toEqual({
      kind: EAuthKind.ApiKey,
      apiKey: 'or-key',
    })
    expect(await serviceWith().activeFor(EAuthProvider.OpenRouter)).toBe(account.id)
  })

  it('moves the pointer to a surviving account when the active one is removed', async () => {
    const service = serviceWith()
    const first = await vault.addAccount({ label: 'work', secret: oauthSecret({}) })
    const second = await vault.addAccount({ label: 'personal', secret: oauthSecret({}) })

    await service.remove(first.id)

    expect(await service.activeFor(EAuthProvider.Anthropic)).toBe(second.id)
  })

  it('leaves the pointer alone when the account removed was not the active one', async () => {
    const service = serviceWith()
    const first = await vault.addAccount({ label: 'work', secret: oauthSecret({}) })
    const second = await vault.addAccount({ label: 'personal', secret: oauthSecret({}) })

    await service.remove(second.id)

    expect(await service.activeFor(EAuthProvider.Anthropic)).toBe(first.id)
  })

  it('says nothing was removed rather than failing on an account that is already gone', async () => {
    const account = await vault.addAccount({ label: 'work', secret: oauthSecret({}) })
    const service = serviceWith()

    await service.remove(account.id)

    expect(service.remove(account.id)).resolves.toBeUndefined()
  })

  it('reports a login it could not complete without leaving an account behind', async () => {
    const service = new AccountsService({
      accounts: vault.store,
      clients: {
        [EAuthProvider.Anthropic]: new AnthropicOauthClient({
          clock,
          fetch: async () => new Response('{}', { status: 400 }),
        }),
      },
    })
    const ticket = service.begin(EAuthProvider.Anthropic)

    const failure = await service
      .complete({ ticket, pasted: 'code' })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect(await service.list()).toEqual([])
  })

  it('names the failure kind when a provider cannot take an api key either', async () => {
    const failure = await serviceWith()
      .addApiKey({ provider: EAuthProvider.OpenRouter, apiKey: 'k' })
      .then(() => undefined)
      .catch((error: unknown) => error)

    expect(failure).toBeUndefined()

    const refused = await serviceWith()
      .complete({
        ticket: {
          provider: EAuthProvider.OpenRouter,
          url: '',
          pkce: { verifier: 'v', challenge: 'c', state: 's' },
        },
        pasted: 'code',
      })
      .catch((error: unknown) => error)

    expect((refused as CredentialError).failure).toBe(ECredentialFailure.StoreUnavailable)
  })
})
