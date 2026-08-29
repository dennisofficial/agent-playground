import { describe, expect, it } from 'bun:test'

import {
  EAccountOrigin,
  EAccountStatus,
  EAuthKind,
  EAuthProvider,
  toAccountId,
  type Account,
} from '@dltech/atlas-core'

import {
  accountDetail,
  accountRows,
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

describe('accountRows', () => {
  it('marks the account that answers for its provider', () => {
    const rows = rowsOf([account({ id: 'work' }), account({ id: 'personal' })], 'personal')

    expect(rows.map((row) => [String(row.account.id), row.active])).toEqual([
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

    expect(rows.map((row) => String(row.account.id))).toEqual(['first', 'second', 'openrouter'])
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
  const state = openAccounts({ rows: rowsOf([account({ id: 'a' }), account({ id: 'b' })]) })

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
    const removed = withRows({ state: moveSelection({ state, delta: 1 }), rows: rowsOf([account({ id: 'a' })]) })

    expect(removed.index).toBe(0)
    expect(String(selectedRow(removed)?.account.id)).toBe('a')
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
})
