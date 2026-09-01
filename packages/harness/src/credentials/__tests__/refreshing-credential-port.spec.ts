import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import {
  EAccountStatus,
  EAuthKind,
  EAuthProvider,
  type AccountId,
  type OauthTokens,
} from '@dltech/atlas-core'

import { CredentialError, ECredentialFailure } from '../credential-error'
import type { CredentialSink } from '../credential-sink'
import { OauthHttpError } from '../oauth'
import { RefreshingCredentialPort } from '../refreshing-credential-port'
import {
  minutesFromNow,
  movableClock,
  oauthSecret,
  openVault,
  tokens,
  type Vault,
} from './vault-fixture'

class ScriptedRefresh {
  calls = 0
  constructor(private readonly answer: (call: number) => Promise<OauthTokens>) {}

  refresh = async (args: { refreshToken: string }): Promise<OauthTokens> => {
    this.calls += 1
    this.seen.push(args.refreshToken)
    return this.answer(this.calls)
  }

  readonly seen: string[] = []
}

const rotating = (expiresAt = minutesFromNow(120)): ScriptedRefresh =>
  new ScriptedRefresh(async (call) =>
    tokens({ access: `access-${call + 1}`, refresh: `refresh-${call + 1}`, expiresAt }),
  )

const failing = (status: number): ScriptedRefresh =>
  new ScriptedRefresh(async () => {
    throw new OauthHttpError({ provider: 'Anthropic', status })
  })

const unreachable = (): ScriptedRefresh =>
  new ScriptedRefresh(async () => {
    throw new Error('socket hang up')
  })

let clock = movableClock()
let vault: Vault

const portWith = (args: {
  client: ScriptedRefresh
  sinks?: readonly CredentialSink[]
  sinkTtlMs?: number
}) =>
  new RefreshingCredentialPort({
    accounts: vault.store,
    clients: { [EAuthProvider.Anthropic]: args.client },
    clock,
    ...(args.sinks === undefined ? {} : { sinks: args.sinks }),
    ...(args.sinkTtlMs === undefined ? {} : { sinkTtlMs: args.sinkTtlMs }),
  })

const failureOf = async (read: Promise<unknown>): Promise<CredentialError> => {
  const error = await read.then(() => undefined).catch((thrown: unknown) => thrown)
  if (error instanceof CredentialError) return error
  throw new Error(`expected a CredentialError, got ${String(error)}`)
}

const statusOf = async (accountId: AccountId): Promise<EAccountStatus | undefined> =>
  (await vault.store.list()).find((account) => account.id === accountId)?.status

beforeEach(() => {
  clock = movableClock()
  vault = openVault(clock)
})

afterEach(() => {
  vault.close()
})

describe('RefreshingCredentialPort', () => {
  it('hands back a token that has life left without calling the server', async () => {
    const account = await vault.addAccount({ label: 'work', secret: oauthSecret({}) })
    const client = rotating()

    const credential = await portWith({ client }).read()

    expect(credential).toEqual({
      kind: EAuthKind.Oauth,
      accountId: account.id,
      accessToken: 'access-1',
      expiresAt: minutesFromNow(60),
    })
    expect(client.calls).toBe(0)
  })

  it('refreshes inside the skew window, before the turn that would have failed', async () => {
    await vault.addAccount({ label: 'work', secret: oauthSecret({ expiresAt: minutesFromNow(2) }) })
    const client = rotating()

    const credential = await portWith({ client }).read()

    expect(client.seen).toEqual(['refresh-1'])
    expect(credential).toMatchObject({ accessToken: 'access-2' })
  })

  it('keeps the rotated pair, so the next read needs no second exchange', async () => {
    await vault.addAccount({ label: 'work', secret: oauthSecret({ expiresAt: minutesFromNow(2) }) })
    const client = rotating()
    const port = portWith({ client })

    await port.read()
    const second = await port.read()

    expect(client.calls).toBe(1)
    expect(second).toMatchObject({ accessToken: 'access-2' })
  })

  it('refreshes a credential that expired while Atlas was closed', async () => {
    await vault.addAccount({
      label: 'work',
      secret: oauthSecret({ expiresAt: minutesFromNow(-600) }),
    })
    const client = rotating()

    expect(await portWith({ client }).read()).toMatchObject({ accessToken: 'access-2' })
  })

  it('spends one refresh token on two callers arriving in the same tick', async () => {
    await vault.addAccount({ label: 'work', secret: oauthSecret({ expiresAt: minutesFromNow(2) }) })
    const client = rotating()
    const port = portWith({ client })

    const [first, second] = await Promise.all([port.read(), port.read()])

    expect(client.calls).toBe(1)
    expect(first).toEqual(second)
  })

  it('retires an account the server refused, and says how to sign in', async () => {
    const account = await vault.addAccount({
      label: 'work',
      secret: oauthSecret({ expiresAt: minutesFromNow(2) }),
    })

    const error = await failureOf(portWith({ client: failing(400) }).read())

    expect(error.failure).toBe(ECredentialFailure.Expired)
    expect(error.message).toContain('/auth')
    expect(error.message).not.toContain('refresh-1')
    expect(await statusOf(account.id)).toBe(EAccountStatus.Expired)
  })

  it('takes the pair another Atlas left in the vault rather than retiring over a lost race', async () => {
    const account = await vault.addAccount({
      label: 'work',
      secret: oauthSecret({ expiresAt: minutesFromNow(2) }),
    })

    const client = new ScriptedRefresh(async () => {
      await vault.store.replaceSecret({
        accountId: account.id,
        secret: oauthSecret({
          access: 'other-instance-access',
          refresh: 'other-instance-refresh',
          expiresAt: minutesFromNow(300),
        }),
      })
      throw new OauthHttpError({ provider: 'Anthropic', status: 400 })
    })

    expect(await portWith({ client }).read()).toMatchObject({
      accessToken: 'other-instance-access',
    })
    expect(await statusOf(account.id)).toBe(EAccountStatus.Active)
  })

  it('still retires when the refusal is not a race and nothing else moved', async () => {
    const account = await vault.addAccount({
      label: 'work',
      secret: oauthSecret({ expiresAt: minutesFromNow(2) }),
    })

    const error = await failureOf(portWith({ client: failing(400) }).read())

    expect(error.failure).toBe(ECredentialFailure.Expired)
    expect(await statusOf(account.id)).toBe(EAccountStatus.Expired)
  })

  it('rides out a network blip on a token that still has life', async () => {
    await vault.addAccount({ label: 'work', secret: oauthSecret({ expiresAt: minutesFromNow(2) }) })

    expect(await portWith({ client: unreachable() }).read()).toMatchObject({
      accessToken: 'access-1',
    })
  })

  it('reports a blip that leaves nothing usable as a refresh failure, not a dead account', async () => {
    const account = await vault.addAccount({
      label: 'work',
      secret: oauthSecret({ expiresAt: minutesFromNow(-5) }),
    })

    const error = await failureOf(portWith({ client: unreachable() }).read())

    expect(error.failure).toBe(ECredentialFailure.RefreshFailed)
    expect(await statusOf(account.id)).toBe(EAccountStatus.Active)
  })

  it('revives an account whose refresh works again', async () => {
    const account = await vault.addAccount({
      label: 'work',
      secret: oauthSecret({ expiresAt: minutesFromNow(2) }),
    })
    await vault.store.setStatus({ accountId: account.id, status: EAccountStatus.Expired })

    await portWith({ client: rotating() }).read()

    expect(await statusOf(account.id)).toBe(EAccountStatus.Active)
  })

  it('refreshes a token the server refused, whatever its expiry claims', async () => {
    await vault.addAccount({
      label: 'work',
      secret: oauthSecret({ expiresAt: minutesFromNow(100) }),
    })
    const client = rotating()
    const port = portWith({ client })

    const refused = await port.read()
    await port.discard(refused)

    expect(await port.read()).toMatchObject({ accessToken: 'access-2' })
    expect(client.calls).toBe(1)
  })

  it('goes back to trusting expiry once the refused pair has been replaced', async () => {
    await vault.addAccount({
      label: 'work',
      secret: oauthSecret({ expiresAt: minutesFromNow(100) }),
    })
    const client = rotating()
    const port = portWith({ client })

    await port.discard(await port.read())
    await port.read()
    await port.read()

    expect(client.calls).toBe(1)
  })

  it('retires an account whose refused token has nothing to refresh with', async () => {
    const account = await vault.addAccount({
      label: 'work',
      secret: oauthSecret({ refresh: '', expiresAt: minutesFromNow(100) }),
    })
    const port = portWith({ client: rotating() })

    await port.discard(await port.read())

    const error = await failureOf(port.read())
    expect(error.failure).toBe(ECredentialFailure.Expired)
    expect(await statusOf(account.id)).toBe(EAccountStatus.Active)
  })

  it('answers from the account the operator made active', async () => {
    await vault.addAccount({ label: 'work', secret: oauthSecret({ access: 'work-token' }) })
    const personal = await vault.addAccount({
      label: 'personal',
      secret: oauthSecret({ access: 'personal-token' }),
    })

    await vault.store.setActive({ provider: EAuthProvider.Anthropic, accountId: personal.id })

    expect(await portWith({ client: rotating() }).read()).toMatchObject({
      accessToken: 'personal-token',
    })
  })

  it('answers from the account a caller named, whatever is active', async () => {
    const work = await vault.addAccount({
      label: 'work',
      secret: oauthSecret({ access: 'work-token' }),
    })
    const personal = await vault.addAccount({
      label: 'personal',
      secret: oauthSecret({ access: 'personal-token' }),
    })
    await vault.store.setActive({ provider: EAuthProvider.Anthropic, accountId: personal.id })

    expect(await portWith({ client: rotating() }).read({ accountId: work.id })).toMatchObject({
      accessToken: 'work-token',
    })
  })

  it('never refreshes an api key', async () => {
    await vault.addAccount({
      label: 'metered',
      secret: { kind: EAuthKind.ApiKey, apiKey: 'sk-ant-api-key' },
    })
    const client = rotating()

    expect(await portWith({ client }).read()).toMatchObject({
      kind: EAuthKind.ApiKey,
      apiKey: 'sk-ant-api-key',
    })
    expect(client.calls).toBe(0)
  })

  it('says which provider has no account, without a stack trace to read', async () => {
    const error = await failureOf(portWith({ client: rotating() }).read())

    expect(error.failure).toBe(ECredentialFailure.NotFound)
    expect(error.message).toContain('/auth')
  })

  it('refuses a provider Atlas cannot refresh yet rather than pretending', async () => {
    await vault.addAccount({
      label: 'codex',
      provider: EAuthProvider.OpenAI,
      secret: oauthSecret({ expiresAt: minutesFromNow(2) }),
    })

    const error = await failureOf(
      portWith({ client: rotating() }).read({ provider: EAuthProvider.OpenAI }),
    )

    expect(error.failure).toBe(ECredentialFailure.StoreUnavailable)
  })
})

describe('an imported credential', () => {
  type Sink = CredentialSink & {
    written: OauthTokens[]
    reads: number
    hold: (tokens: OauthTokens) => void
  }

  const sinkHolding = (held: OauthTokens | undefined): Sink => {
    let current = held
    const written: OauthTokens[] = []

    const sink: Sink = {
      id: 'claude-code',
      written,
      reads: 0,
      hold: (tokens) => {
        current = tokens
      },
      read: async () => {
        sink.reads += 1
        return current
      },
      write: async (rotated) => {
        written.push(rotated)
        current = rotated
      },
    }

    return sink
  }

  it('writes the rotated pair back, so the tool it came from keeps working', async () => {
    await vault.addAccount({
      label: 'imported',
      secret: oauthSecret({ expiresAt: minutesFromNow(2) }),
      importedFrom: 'claude-code',
    })
    const sink = sinkHolding(tokens({ expiresAt: minutesFromNow(2) }))

    await portWith({ client: rotating(), sinks: [sink] }).read()

    expect(sink.written).toHaveLength(1)
    expect(sink.written[0]).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' })
  })

  it('takes up a newer pair the other tool refreshed instead of spending its own', async () => {
    await vault.addAccount({
      label: 'imported',
      secret: oauthSecret({ expiresAt: minutesFromNow(2) }),
      importedFrom: 'claude-code',
    })
    const sink = sinkHolding(
      tokens({ access: 'their-access', refresh: 'their-refresh', expiresAt: minutesFromNow(300) }),
    )
    const client = rotating()

    const credential = await portWith({ client, sinks: [sink] }).read()

    expect(client.calls).toBe(0)
    expect(credential).toMatchObject({ accessToken: 'their-access' })
    expect(sink.written).toEqual([])
  })

  it('takes up the pair the other tool rotated to, long before its own copy runs out', async () => {
    await vault.addAccount({
      label: 'imported',
      secret: oauthSecret({ expiresAt: minutesFromNow(100) }),
      importedFrom: 'claude-code',
    })
    const sink = sinkHolding(
      tokens({ access: 'their-access', refresh: 'their-refresh', expiresAt: minutesFromNow(500) }),
    )
    const client = rotating()

    const credential = await portWith({ client, sinks: [sink] }).read()

    expect(client.calls).toBe(0)
    expect(credential).toMatchObject({ accessToken: 'their-access' })
  })

  it('keeps the pair it took up, so the vault stops handing out the revoked one', async () => {
    const account = await vault.addAccount({
      label: 'imported',
      secret: oauthSecret({ expiresAt: minutesFromNow(100) }),
      importedFrom: 'claude-code',
    })
    const sink = sinkHolding(
      tokens({ access: 'their-access', refresh: 'their-refresh', expiresAt: minutesFromNow(500) }),
    )

    await portWith({ client: rotating(), sinks: [sink] }).read()

    const stored = await vault.store.read(account.id)
    expect(stored?.secret).toMatchObject({ tokens: { accessToken: 'their-access' } })
  })

  it('reads the other store once for a burst of reads on the same pair', async () => {
    await vault.addAccount({
      label: 'imported',
      secret: oauthSecret({ expiresAt: minutesFromNow(100) }),
      importedFrom: 'claude-code',
    })
    const sink = sinkHolding(tokens({ expiresAt: minutesFromNow(100) }))
    const port = portWith({ client: rotating(), sinks: [sink], sinkTtlMs: 10_000 })

    await port.read()
    await port.read()
    await port.read()

    expect(sink.reads).toBe(1)
  })

  it('looks again once the cached look has gone stale', async () => {
    await vault.addAccount({
      label: 'imported',
      secret: oauthSecret({ expiresAt: minutesFromNow(100) }),
      importedFrom: 'claude-code',
    })
    const sink = sinkHolding(tokens({ expiresAt: minutesFromNow(100) }))
    const port = portWith({ client: rotating(), sinks: [sink], sinkTtlMs: 10_000 })

    await port.read()
    sink.hold(
      tokens({ access: 'their-access', refresh: 'their-refresh', expiresAt: minutesFromNow(500) }),
    )
    clock.set(minutesFromNow(1))

    expect(await port.read()).toMatchObject({ accessToken: 'their-access' })
  })

  it('takes the other pair for a refused token instead of spending its own', async () => {
    await vault.addAccount({
      label: 'imported',
      secret: oauthSecret({ expiresAt: minutesFromNow(100) }),
      importedFrom: 'claude-code',
    })
    const sink = sinkHolding(tokens({ expiresAt: minutesFromNow(100) }))
    const client = rotating()
    const port = portWith({ client, sinks: [sink] })

    await port.discard(await port.read())
    sink.hold(
      tokens({ access: 'their-access', refresh: 'their-refresh', expiresAt: minutesFromNow(500) }),
    )

    expect(await port.read()).toMatchObject({ accessToken: 'their-access' })
    expect(client.calls).toBe(0)
  })

  it('spends the pair it just took up, never the one that pair superseded', async () => {
    await vault.addAccount({
      label: 'imported',
      secret: oauthSecret({ expiresAt: minutesFromNow(2) }),
      importedFrom: 'claude-code',
    })
    const sink = sinkHolding(
      tokens({ access: 'their-access', refresh: 'their-refresh', expiresAt: minutesFromNow(3) }),
    )
    const client = rotating()

    await portWith({ client, sinks: [sink] }).read()

    expect(client.seen).toEqual(['their-refresh'])
  })

  it('leaves another account credential in a shared store alone', async () => {
    await vault.addAccount({
      label: 'other',
      secret: oauthSecret({ access: 'other-access', refresh: 'other-refresh' }),
    })
    const imported = await vault.addAccount({
      label: 'imported',
      secret: oauthSecret({ expiresAt: minutesFromNow(2) }),
      importedFrom: 'claude-code',
    })
    await vault.store.setActive({ provider: EAuthProvider.Anthropic, accountId: imported.id })
    const sink = sinkHolding(
      tokens({ access: 'other-access', refresh: 'newer-refresh', expiresAt: minutesFromNow(300) }),
    )
    const client = rotating()

    await portWith({ client, sinks: [sink] }).read()

    expect(client.calls).toBe(1)
  })

  it('does not push an older pair over a newer one the other tool holds', async () => {
    await vault.addAccount({
      label: 'imported',
      secret: oauthSecret({ expiresAt: minutesFromNow(2) }),
      importedFrom: 'claude-code',
    })
    const sink = sinkHolding(
      tokens({ access: 'their-access', refresh: 'their-refresh', expiresAt: minutesFromNow(400) }),
    )

    await portWith({ client: rotating(minutesFromNow(10)), sinks: [sink] }).read()

    expect(sink.written).toEqual([])
  })
})
