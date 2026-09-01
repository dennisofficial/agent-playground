import {
  adoptionOf,
  EAccountStatus,
  EAdoption,
  EAuthKind,
  isSamePair,
  type AccountStorePort,
  type ClockPort,
  type OauthTokens,
  type StoredAccount,
} from '@dltech/atlas-core'

import { sinkFor, type CredentialSink } from './credential-sink'

export const DEFAULT_SINK_TTL_MS = 10_000

const tokensOf = (stored: StoredAccount): OauthTokens | undefined =>
  stored.secret.kind === EAuthKind.Oauth ? stored.secret.tokens : undefined

type Observation = { at: number; tokens: OauthTokens | undefined }

export type Reconciliation = { account: StoredAccount; adopted: boolean }

/**
 * Atlas and the tool a credential was imported from share one OAuth token lineage: the same
 * `client_id`, the same grant. Whichever of the two refreshes first rotates the pair and the other
 * copy is revoked on the server while its own `expiresAt` still reads fresh. So the other tool's
 * store, not the clock, is what says whether the pair Atlas holds is still the live one.
 */
export class SinkReconciler {
  private readonly accounts: AccountStorePort
  private readonly sinks: readonly CredentialSink[]
  private readonly clock: ClockPort
  private readonly ttlMs: number
  private readonly observed = new Map<string, Observation>()

  constructor(args: {
    accounts: AccountStorePort
    sinks: readonly CredentialSink[]
    clock: ClockPort
    ttlMs?: number | undefined
  }) {
    this.accounts = args.accounts
    this.sinks = args.sinks
    this.clock = args.clock
    this.ttlMs = args.ttlMs ?? DEFAULT_SINK_TTL_MS
  }

  async adopt(args: { stored: StoredAccount; bypassCache?: boolean }): Promise<Reconciliation> {
    const unchanged = { account: args.stored, adopted: false }

    const held = tokensOf(args.stored)
    const sink = this.sinkOf(args.stored)
    if (held === undefined || sink === undefined) return unchanged

    const observed = await this.observation({ sink, bypassCache: args.bypassCache === true })
    if (observed === undefined || isSamePair(observed, held)) return unchanged

    const adoption = adoptionOf({
      observed,
      stored: held,
      others: await this.otherTokens(args.stored),
    })
    if (adoption !== EAdoption.Adopt) return unchanged

    const secret = { kind: EAuthKind.Oauth, tokens: observed } as const
    await this.accounts.replaceSecret({ accountId: args.stored.id, secret })

    return { account: { ...args.stored, secret, status: EAccountStatus.Active }, adopted: true }
  }

  async writeBack(args: {
    stored: StoredAccount
    rotated: OauthTokens
    previous: OauthTokens
  }): Promise<void> {
    const sink = this.sinkOf(args.stored)
    if (sink === undefined) return

    const held = await this.read(sink)
    const adoption = adoptionOf({
      observed: args.rotated,
      stored: held ?? args.previous,
      others: [],
    })
    if (adoption !== EAdoption.Adopt) return

    await sink.write(args.rotated).catch(() => undefined)
    this.observed.set(sink.id, { at: this.nowMillis(), tokens: args.rotated })
  }

  private sinkOf(stored: StoredAccount): CredentialSink | undefined {
    return sinkFor({ sinks: this.sinks, importedFrom: stored.importedFrom })
  }

  private async observation(args: {
    sink: CredentialSink
    bypassCache: boolean
  }): Promise<OauthTokens | undefined> {
    const cached = this.observed.get(args.sink.id)
    const now = this.nowMillis()

    if (!args.bypassCache && cached !== undefined && now - cached.at < this.ttlMs)
      return cached.tokens

    const tokens = await this.read(args.sink)
    this.observed.set(args.sink.id, { at: now, tokens })

    return tokens
  }

  private async read(sink: CredentialSink): Promise<OauthTokens | undefined> {
    return sink.read().catch(() => undefined)
  }

  private nowMillis(): number {
    const parsed = Date.parse(this.clock.now())
    return Number.isNaN(parsed) ? 0 : parsed
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
}
