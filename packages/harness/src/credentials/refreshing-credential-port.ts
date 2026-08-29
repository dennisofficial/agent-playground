import {
  adoptionOf,
  chooseAccount,
  CredentialPort,
  EAccountChoice,
  EAccountStatus,
  EAdoption,
  EAuthKind,
  EAuthProvider,
  ENoAccountReason,
  ERefresh,
  isExpired,
  providerSpec,
  refreshDecision,
  type AccountId,
  type AccountStorePort,
  type ClockPort,
  type Credential,
  type CredentialRequest,
  type OauthTokens,
  type StoredAccount,
} from '@dltech/atlas-core'

import { CredentialError, ECredentialFailure } from './credential-error'
import { sinkFor, type CredentialSink } from './credential-sink'
import { isHardAuthFailure, refreshClientFor, type RefreshClients } from './oauth'

const SIGN_IN = 'Sign in with /auth.'

const credentialOf = (stored: StoredAccount): Credential =>
  stored.secret.kind === EAuthKind.ApiKey
    ? { kind: EAuthKind.ApiKey, accountId: stored.id, apiKey: stored.secret.apiKey }
    : {
        kind: EAuthKind.Oauth,
        accountId: stored.id,
        accessToken: stored.secret.tokens.accessToken,
        expiresAt: stored.secret.tokens.expiresAt,
      }

const tokensOf = (stored: StoredAccount): OauthTokens | undefined =>
  stored.secret.kind === EAuthKind.Oauth ? stored.secret.tokens : undefined

export class RefreshingCredentialPort extends CredentialPort {
  private readonly accounts: AccountStorePort
  private readonly clients: RefreshClients
  private readonly clock: ClockPort
  private readonly sinks: readonly CredentialSink[]
  private readonly defaultProvider: EAuthProvider
  private readonly skewMs: number | undefined
  private readonly refreshing = new Map<AccountId, Promise<StoredAccount>>()

  constructor(args: {
    accounts: AccountStorePort
    clients: RefreshClients
    clock: ClockPort
    sinks?: readonly CredentialSink[]
    defaultProvider?: EAuthProvider
    skewMs?: number | undefined
  }) {
    super()
    this.accounts = args.accounts
    this.clients = args.clients
    this.clock = args.clock
    this.sinks = args.sinks ?? []
    this.defaultProvider = args.defaultProvider ?? EAuthProvider.Anthropic
    this.skewMs = args.skewMs
  }

  async read(request?: CredentialRequest): Promise<Credential> {
    const provider = request?.provider ?? this.defaultProvider
    const stored = await this.chosenAccount({ provider, accountId: request?.accountId })

    const decision = refreshDecision({
      secret: stored.secret,
      now: this.clock.now(),
      ...(this.skewMs === undefined ? {} : { skewMs: this.skewMs }),
    })

    if (decision === ERefresh.Fresh) return credentialOf(stored)
    if (decision === ERefresh.Unrefreshable) throw this.expired(stored)

    return credentialOf(await this.sharedRefresh(stored))
  }

  private async chosenAccount(args: {
    provider: EAuthProvider
    accountId: AccountId | undefined
  }): Promise<StoredAccount> {
    const preferred = args.accountId ?? (await this.accounts.activeFor(args.provider))
    const choice = chooseAccount({
      accounts: await this.accounts.list(),
      provider: args.provider,
      preferred,
    })

    if (choice.type === EAccountChoice.Refused) throw this.noAccount(args.provider, choice.reason)

    const stored = await this.accounts.read(choice.account.id)
    if (stored === undefined) throw this.noAccount(args.provider, ENoAccountReason.NoneForProvider)

    return stored
  }

  private sharedRefresh(stored: StoredAccount): Promise<StoredAccount> {
    const inFlight = this.refreshing.get(stored.id)
    if (inFlight !== undefined) return inFlight

    const work = this.refresh(stored).finally(() => {
      this.refreshing.delete(stored.id)
    })
    this.refreshing.set(stored.id, work)

    return work
  }

  private async refresh(stored: StoredAccount): Promise<StoredAccount> {
    const tokens = tokensOf(stored)
    if (tokens === undefined) return stored

    const sink = sinkFor({ sinks: this.sinks, importedFrom: stored.importedFrom })
    const adopted = await this.adoptFromSink({ stored, tokens, sink })
    if (adopted !== undefined) return adopted

    const client = refreshClientFor({ clients: this.clients, provider: stored.provider })

    try {
      const rotated = await client.refresh({ refreshToken: tokens.refreshToken })
      const secret = { kind: EAuthKind.Oauth, tokens: rotated } as const

      await this.accounts.replaceSecret({ accountId: stored.id, secret })
      await this.writeBack({ sink, rotated, previous: tokens })

      return { ...stored, secret, status: EAccountStatus.Active }
    } catch (error) {
      if (isHardAuthFailure(error)) {
        await this.accounts.setStatus({ accountId: stored.id, status: EAccountStatus.Expired })
        throw this.expired(stored)
      }
      if (isExpired({ secret: stored.secret, now: this.clock.now() })) throw this.unreachable(error)

      return stored
    }
  }

  /**
   * The tool the credential was imported from refreshes it too. If its pair is the newer one, taking
   * it up costs no network call and avoids spending our refresh token on a race we have lost.
   */
  private async adoptFromSink(args: {
    stored: StoredAccount
    tokens: OauthTokens
    sink: CredentialSink | undefined
  }): Promise<StoredAccount | undefined> {
    if (args.sink === undefined) return undefined

    const observed = await args.sink.read().catch(() => undefined)
    if (observed === undefined) return undefined

    const adoption = adoptionOf({
      observed,
      stored: args.tokens,
      others: await this.otherTokens(args.stored),
    })
    if (adoption !== EAdoption.Adopt) return undefined

    const secret = { kind: EAuthKind.Oauth, tokens: observed } as const
    await this.accounts.replaceSecret({ accountId: args.stored.id, secret })

    const next: StoredAccount = { ...args.stored, secret, status: EAccountStatus.Active }
    const decision = refreshDecision({
      secret,
      now: this.clock.now(),
      ...(this.skewMs === undefined ? {} : { skewMs: this.skewMs }),
    })

    return decision === ERefresh.Fresh ? next : undefined
  }

  private async writeBack(args: {
    sink: CredentialSink | undefined
    rotated: OauthTokens
    previous: OauthTokens
  }): Promise<void> {
    if (args.sink === undefined) return

    const held = await args.sink.read().catch(() => undefined)
    const adoption = adoptionOf({
      observed: args.rotated,
      stored: held ?? args.previous,
      others: [],
    })
    if (adoption !== EAdoption.Adopt) return

    await args.sink.write(args.rotated).catch(() => undefined)
  }

  private async otherTokens(stored: StoredAccount): Promise<readonly OauthTokens[]> {
    const siblings = (await this.accounts.list()).filter(
      (account) => account.provider === stored.provider && account.id !== stored.id,
    )

    const secrets = await Promise.all(siblings.map((account) => this.accounts.read(account.id)))

    return secrets.flatMap((sibling) => {
      if (sibling === undefined) return []
      const tokens = tokensOf(sibling)
      return tokens === undefined ? [] : [tokens]
    })
  }

  private expired(stored: StoredAccount): CredentialError {
    return new CredentialError({
      failure: ECredentialFailure.Expired,
      message: `The ${providerSpec(stored.provider).label} login for ${stored.label} has expired and could not be refreshed. ${SIGN_IN}`,
    })
  }

  private unreachable(error: unknown): CredentialError {
    return new CredentialError({
      failure: ECredentialFailure.RefreshFailed,
      message: `The credential expired and the token endpoint could not be reached to refresh it: ${error instanceof Error ? error.message : 'the request failed'}.`,
    })
  }

  private noAccount(provider: EAuthProvider, reason: ENoAccountReason): CredentialError {
    const label = providerSpec(provider).label
    const detail =
      reason === ENoAccountReason.NoneAtAll
        ? 'Atlas holds no accounts.'
        : `Atlas holds no ${label} account.`

    return new CredentialError({ failure: ECredentialFailure.NotFound, message: `${detail} ${SIGN_IN}` })
  }
}
