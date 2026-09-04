import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { EAccountOrigin, EAuthKind, EAuthProvider } from '@dltech/atlas-core'

import { AccountsService } from '../accounts-service'
import { CredentialError, ECredentialFailure } from '../credential-error'
import {
  AnthropicOauthClient,
  EDevicePoll,
  type DevicePoll,
  type OauthClients,
} from '../oauth'
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

class ScriptedDeviceClient {
  polls = 0

  constructor(private readonly script: readonly DevicePoll[]) {}

  startDeviceLogin = async () => ({
    deviceAuthId: 'da-1',
    userCode: 'ABCD-EFGH',
    verificationUrl: 'https://auth.openai.com/codex/device',
    intervalMs: 3000,
    expiresInMs: 900_000,
  })

  pollDeviceLogin = async (): Promise<DevicePoll> => {
    const step = this.script[Math.min(this.polls, this.script.length - 1)]
    this.polls += 1
    if (step === undefined) throw new Error('the script ran out')
    return step
  }

  refresh = async () => ({
    accessToken: 'openai-access-2',
    refreshToken: 'openai-refresh-2',
    expiresAt: '2026-01-01T14:00:00.000Z',
  })
}

const DEVICE_LOGIN = {
  tokens: {
    accessToken: 'openai-access',
    refreshToken: 'openai-refresh',
    expiresAt: '2026-01-01T13:00:00.000Z',
    accountId: 'acct-123',
  },
  email: 'dennis@example.com',
  subscription: 'plus',
}

const deviceServiceWith = (script: readonly DevicePoll[]) =>
  new AccountsService({
    accounts: vault.store,
    clients: { [EAuthProvider.OpenAI]: new ScriptedDeviceClient(script) },
  })

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

  it('starts a device login with the code the operator will type into the browser', async () => {
    const ticket = await deviceServiceWith([]).beginDevice(EAuthProvider.OpenAI)

    expect(ticket).toMatchObject({
      provider: EAuthProvider.OpenAI,
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://auth.openai.com/codex/device',
    })
  })

  it('reports a pending poll without leaving an account behind', async () => {
    const service = deviceServiceWith([{ status: EDevicePoll.Pending }])
    const ticket = await service.beginDevice(EAuthProvider.OpenAI)

    expect(await service.pollDevice(ticket)).toEqual({ status: EDevicePoll.Pending })
    expect(await service.list()).toEqual([])
  })

  it('signs in on the poll that completes and makes the account the one that answers', async () => {
    const service = deviceServiceWith([
      { status: EDevicePoll.Pending },
      { status: EDevicePoll.Complete, login: DEVICE_LOGIN },
    ])
    const ticket = await service.beginDevice(EAuthProvider.OpenAI)

    await service.pollDevice(ticket)
    const signIn = await service.pollDevice(ticket)

    expect(signIn.status).toBe(EDevicePoll.Complete)
    if (signIn.status !== EDevicePoll.Complete) return

    expect(signIn.account.label).toBe('dennis@example.com')
    expect(signIn.account.provider).toBe(EAuthProvider.OpenAI)
    expect(await service.activeFor(EAuthProvider.OpenAI)).toBe(signIn.account.id)

    const stored = await vault.store.read(signIn.account.id)
    expect(stored?.secret).toEqual({ kind: EAuthKind.Oauth, tokens: DEVICE_LOGIN.tokens })
  })

  it('refuses a paste-back login for a device-code provider, and the reverse', async () => {
    expect(() => serviceWith().begin(EAuthProvider.OpenAI)).toThrow(CredentialError)
    expect(deviceServiceWith([]).beginDevice(EAuthProvider.Anthropic)).rejects.toThrow(
      CredentialError,
    )
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
