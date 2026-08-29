import {
  EAccountOrigin,
  EAuthKind,
  EAuthProvider,
  ELoginFlow,
  providerSpec,
  type Account,
  type AccountId,
  type AccountStorePort,
} from '@dltech/atlas-core'

import { clientFor, unsupportedProvider, type OauthClients, type Pkce } from './oauth'

export type LoginTicket = { provider: EAuthProvider; url: string; pkce: Pkce }

const labelFor = (args: {
  provider: EAuthProvider
  email: string | undefined
  subscription: string | undefined
}): string => {
  if (args.email !== undefined) return args.email

  const spec = providerSpec(args.provider)
  return args.subscription === undefined ? spec.label : `${spec.label} (${args.subscription})`
}

export class AccountsService {
  private readonly accounts: AccountStorePort
  private readonly clients: OauthClients

  constructor(args: { accounts: AccountStorePort; clients: OauthClients }) {
    this.accounts = args.accounts
    this.clients = args.clients
  }

  list(): Promise<readonly Account[]> {
    return Promise.resolve(this.accounts.list())
  }

  activeFor(provider: EAuthProvider): Promise<AccountId | undefined> {
    return Promise.resolve(this.accounts.activeFor(provider))
  }

  begin(provider: EAuthProvider): LoginTicket {
    if (!providerSpec(provider).logins.includes(ELoginFlow.PastedCode))
      throw unsupportedProvider(provider)

    const client = clientFor({ clients: this.clients, provider })
    const pkce = client.generatePkce()

    return { provider, url: client.authorizeUrl(pkce), pkce }
  }

  async complete(args: { ticket: LoginTicket; pasted: string }): Promise<Account> {
    const client = clientFor({ clients: this.clients, provider: args.ticket.provider })
    const login = await client.exchange({ pasted: args.pasted, pkce: args.ticket.pkce })

    const added = await this.accounts.add({
      provider: args.ticket.provider,
      label: labelFor({
        provider: args.ticket.provider,
        email: login.email,
        subscription: login.subscription,
      }),
      secret: { kind: EAuthKind.Oauth, tokens: login.tokens },
      origin: EAccountOrigin.Login,
      ...(login.email === undefined ? {} : { email: login.email }),
      ...(login.subscription === undefined ? {} : { subscription: login.subscription }),
    })

    await this.accounts.setActive({ provider: args.ticket.provider, accountId: added.id })

    return added
  }

  async addApiKey(args: { provider: EAuthProvider; apiKey: string }): Promise<Account> {
    const spec = providerSpec(args.provider)
    if (!spec.kinds.includes(EAuthKind.ApiKey)) throw unsupportedProvider(args.provider)

    const added = await this.accounts.add({
      provider: args.provider,
      label: `${spec.label} api key`,
      secret: { kind: EAuthKind.ApiKey, apiKey: args.apiKey.trim() },
      origin: EAccountOrigin.Login,
    })

    await this.accounts.setActive({ provider: args.provider, accountId: added.id })

    return added
  }

  /**
   * Removing the account Atlas was answering with leaves the provider pointing at nothing, so the
   * next healthiest account of the same provider takes the pointer rather than the choice being
   * silently reopened mid-session.
   */
  async remove(accountId: AccountId): Promise<void> {
    const held = (await this.accounts.list()).find((account) => account.id === accountId)
    if (held === undefined) return

    await this.accounts.remove(accountId)

    const active = await this.accounts.activeFor(held.provider)
    if (active !== undefined) return

    const successor = (await this.accounts.list()).find(
      (account) => account.provider === held.provider,
    )
    if (successor === undefined) return

    await this.accounts.setActive({ provider: held.provider, accountId: successor.id })
  }

  use(args: { provider: EAuthProvider; accountId: AccountId }): Promise<void> {
    return Promise.resolve(this.accounts.setActive(args))
  }
}
