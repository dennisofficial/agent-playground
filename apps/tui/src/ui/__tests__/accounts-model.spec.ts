import { describe, expect, it } from 'bun:test'

import {
  EAccountOrigin,
  EAccountStatus,
  EAuthKind,
  EAuthProvider,
  reachableProviders,
  toAccountId,
  type Account,
} from '@dltech/atlas-core'

import {
  accountDetail,
  accountRows,
  EAccountRow,
  rowDetail,
  rowLabel,
  rowProvider,
  askForApiKey,
  askForCode,
  backspace,
  backToList,
  EAccountsView,
  failed,
  isPrompting,
  maskedKey,
  moveSelection,
  openAccounts,
  selectedRow,
  typeInto,
  withRows,
} from '../accounts-model'

const account = (args: {
  id: string
  provider?: EAuthProvider
  kind?: EAuthKind
  origin?: EAccountOrigin
  status?: EAccountStatus
  createdAt?: string
}): Account => ({
  id: toAccountId(args.id),
  provider: args.provider ?? EAuthProvider.Anthropic,
  kind: args.kind ?? EAuthKind.Oauth,
  origin: args.origin ?? EAccountOrigin.Login,
  label: args.id,
  status: args.status ?? EAccountStatus.Active,
  createdAt: args.createdAt ?? '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

const rowsOf = (accounts: readonly Account[], activeId?: string) =>
  accountRows({
    accounts,
    active: activeId === undefined ? {} : { [EAuthProvider.Anthropic]: toAccountId(activeId) },
  })

/**
 * List mechanics are about clamping an index, not about which providers ship reachable today, so
 * they run over the account rows alone — a flipped `reachable` flag must not move them.
 */
const signedInRows = (accounts: readonly Account[], activeId?: string) =>
  rowsOf(accounts, activeId).filter((row) => row.kind === EAccountRow.Account)

const reachable = (): readonly EAuthProvider[] => reachableProviders().map((spec) => spec.provider)

describe('accountRows', () => {
  it('marks the account that answers for its provider', () => {
    const rows = signedInRows([account({ id: 'work' }), account({ id: 'personal' })], 'personal')

    expect(rows.map((row) => [rowLabel(row), row.active])).toEqual([
      ['work', false],
      ['personal', true],
    ])
  })

  it('groups by provider, oldest first inside a provider', () => {
    const rows = accountRows({
      accounts: [
        account({ id: 'openrouter', provider: EAuthProvider.OpenRouter }),
        account({ id: 'second', createdAt: '2026-02-01T00:00:00.000Z' }),
        account({ id: 'first', createdAt: '2026-01-01T00:00:00.000Z' }),
      ],
      active: {},
    })

    expect(rows.filter((row) => row.kind === EAccountRow.Account).map(rowLabel)).toEqual([
      'first',
      'second',
      'openrouter',
    ])
  })
})

describe('a provider with no account yet', () => {
  const signedOut = (rows: readonly ReturnType<typeof accountRows>[number][]) =>
    rows.flatMap((row) => (row.kind === EAccountRow.SignedOut ? [row.provider] : []))

  it('offers a row for every reachable provider nothing is signed into', () => {
    const rows = accountRows({ accounts: [], active: {} })

    expect([...signedOut(rows)].sort()).toEqual([...reachable()].sort())
  })

  it('drops the placeholder once that provider has an account', () => {
    const rows = accountRows({ accounts: [account({ id: 'work' })], active: {} })

    expect(signedOut(rows)).not.toContain(EAuthProvider.Anthropic)
    expect(signedOut(rows).length).toBe(reachable().length - 1)
  })

  it('never offers a provider with no adapter behind it', () => {
    const rows = accountRows({ accounts: [], active: {} })

    for (const provider of signedOut(rows)) expect(reachable()).toContain(provider)
  })

  it('ranks placeholders with the accounts, not in a clump at the end', () => {
    const rows = accountRows({
      accounts: [account({ id: 'inference', provider: EAuthProvider.Inference })],
      active: {},
    })

    expect(rows.map(rowProvider).at(-1)).toBe(EAuthProvider.Inference)
    expect(rows.at(-1)?.kind).toBe(EAccountRow.Account)
    expect(rows[0]?.kind).toBe(EAccountRow.SignedOut)
  })

  it('names the provider and says how to sign in, without crying wolf', () => {
    const [row] = accountRows({ accounts: [], active: {} })
    if (row === undefined) throw new Error('expected a row')

    expect(rowLabel(row)).toBe('Anthropic')
    expect(rowDetail(row)).toContain('not signed in')
    expect(rowDetail(row)).not.toContain('⚠')
  })

  it('offers only the flows that provider actually accepts', () => {
    const rows = accountRows({ accounts: [], active: {} })
    const openrouter = rows.find((row) => rowProvider(row) === EAuthProvider.OpenRouter)
    const anthropic = rows.find((row) => rowProvider(row) === EAuthProvider.Anthropic)
    if (openrouter === undefined || anthropic === undefined) throw new Error('expected both')

    expect(rowDetail(openrouter)).toContain('api key')
    expect(rowDetail(openrouter)).not.toContain('sign in ')
    expect(rowDetail(anthropic)).toContain('sign in')
    expect(rowDetail(anthropic)).toContain('api key')
  })

  it('is never the active row, because nothing is answering for it', () => {
    const rows = accountRows({ accounts: [], active: {} })

    expect(rows.every((row) => !row.active)).toBe(true)
  })
})

describe('openAccounts', () => {
  it('starts on the account that answers today', () => {
    const state = openAccounts({ rows: rowsOf([account({ id: 'a' }), account({ id: 'b' })], 'b') })

    expect(state.index).toBe(1)
    expect(state.view).toBe(EAccountsView.List)
    expect(isPrompting(state)).toBe(false)
  })

  it('carries a notice in, which is how a failed boot explains itself', () => {
    const state = openAccounts({ rows: [], notice: 'The credential expired.' })

    expect(state.notice).toBe('The credential expired.')
    expect(state.index).toBe(0)
  })
})

describe('moving through the list', () => {
  const state = openAccounts({ rows: signedInRows([account({ id: 'a' }), account({ id: 'b' })]) })

  it('stops at each end rather than wrapping', () => {
    expect(moveSelection({ state, delta: -1 }).index).toBe(0)
    expect(moveSelection({ state, delta: 5 }).index).toBe(1)
  })

  it('has nothing to select in an empty vault', () => {
    const empty = openAccounts({ rows: [] })

    expect(moveSelection({ state: empty, delta: 1 })).toBe(empty)
    expect(selectedRow(empty)).toBeUndefined()
  })

  it('keeps the selection inside a list that shrank under it', () => {
    const removed = withRows({
      state: moveSelection({ state, delta: 1 }),
      rows: signedInRows([account({ id: 'a' })]),
    })

    const picked = selectedRow(removed)
    if (picked === undefined) throw new Error('expected a row')

    expect(removed.index).toBe(0)
    expect(rowLabel(picked)).toBe('a')
  })
})

describe('the login prompt', () => {
  const state = openAccounts({ rows: [] })

  it('shows the URL to open and takes what is typed back', () => {
    const asked = askForCode({
      state,
      prompt: { provider: EAuthProvider.Anthropic, url: 'https://claude.com/auth' },
    })
    const typed = typeInto({ state: typeInto({ state: asked, text: 'cod' }), text: 'e' })

    expect(asked.view).toBe(EAccountsView.PastedCode)
    expect(asked.prompt?.url).toBe('https://claude.com/auth')
    expect(typed.typed).toBe('code')
    expect(backspace(typed).typed).toBe('cod')
  })

  it('clears a failure the moment the operator types again', () => {
    const asked = askForCode({
      state,
      prompt: { provider: EAuthProvider.Anthropic, url: 'https://claude.com/auth' },
    })
    const broken = failed({ state: asked, reason: 'the code was refused' })

    expect(broken.failure).toBe('the code was refused')
    expect(typeInto({ state: broken, text: 'a' }).failure).toBeNull()
  })

  it('leaves nothing typed behind when it closes', () => {
    const typed = typeInto({
      state: askForApiKey({ state, provider: EAuthProvider.OpenRouter }),
      text: 'sk-secret',
    })

    expect(backToList(typed).typed).toBe('')
    expect(backToList(typed).view).toBe(EAccountsView.List)
  })

  it('masks all but the last four characters of a key', () => {
    expect(maskedKey('sk-abcdefgh')).toBe('•••••••efgh')
    expect(maskedKey('abc')).toBe('•••')
  })
})

describe('accountDetail', () => {
  it('says where an account came from and what is wrong with it', () => {
    expect(
      accountDetail(
        account({
          id: 'a',
          kind: EAuthKind.ApiKey,
          origin: EAccountOrigin.Environment,
          status: EAccountStatus.Expired,
        }),
      ),
    ).toBe('Anthropic · api key · from the environment · expired')
  })

  it('says nothing about the status of an account that is fine', () => {
    expect(accountDetail(account({ id: 'a' }))).toBe('Anthropic · subscription')
  })

  it('says nothing about adapters for a provider that has one', () => {
    expect(
      accountDetail(
        account({ id: 'a', provider: EAuthProvider.OpenRouter, kind: EAuthKind.ApiKey }),
      ),
    ).toBe('OpenRouter · api key')
  })
})
