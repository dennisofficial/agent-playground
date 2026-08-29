import {
  EAccountOrigin,
  EAccountStatus,
  EAuthKind,
  EAuthProvider,
  providerSpec,
  type Account,
  type AccountId,
} from '@dltech/atlas-core'

export enum EAccountsView {
  List = 'list',
  PastedCode = 'pasted-code',
  ApiKey = 'api-key',
}

export type AccountRow = {
  account: Account
  active: boolean
}

export type AccountsPrompt = {
  provider: EAuthProvider
  url: string
}

export type AccountsState = {
  view: EAccountsView
  index: number
  rows: readonly AccountRow[]
  prompt: AccountsPrompt | null
  typed: string
  notice: string | null
  failure: string | null
  busy: boolean
}

const PROVIDER_ORDER: readonly EAuthProvider[] = [
  EAuthProvider.Anthropic,
  EAuthProvider.OpenAI,
  EAuthProvider.OpenRouter,
]

const rank = (account: Account): number => {
  const at = PROVIDER_ORDER.indexOf(account.provider)
  return at < 0 ? PROVIDER_ORDER.length : at
}

export function accountRows(args: {
  accounts: readonly Account[]
  active: Partial<Record<EAuthProvider, AccountId | undefined>>
}): readonly AccountRow[] {
  return [...args.accounts]
    .sort((left, right) => rank(left) - rank(right) || left.createdAt.localeCompare(right.createdAt))
    .map((account) => ({ account, active: args.active[account.provider] === account.id }))
}

export function openAccounts(args: {
  rows: readonly AccountRow[]
  notice?: string | null
}): AccountsState {
  const active = args.rows.findIndex((row) => row.active)

  return {
    view: EAccountsView.List,
    index: active < 0 ? 0 : active,
    rows: args.rows,
    prompt: null,
    typed: '',
    notice: args.notice ?? null,
    failure: null,
    busy: false,
  }
}

export function withRows(args: {
  state: AccountsState
  rows: readonly AccountRow[]
}): AccountsState {
  const index = Math.min(args.state.index, Math.max(0, args.rows.length - 1))
  return { ...args.state, rows: args.rows, index }
}

export function moveSelection(args: { state: AccountsState; delta: number }): AccountsState {
  if (args.state.rows.length === 0) return args.state

  const last = args.state.rows.length - 1
  const index = Math.min(last, Math.max(0, args.state.index + Math.trunc(args.delta)))

  return { ...args.state, index }
}

export const selectedRow = (state: AccountsState): AccountRow | undefined =>
  state.rows[state.index]

export function askForCode(args: { state: AccountsState; prompt: AccountsPrompt }): AccountsState {
  return {
    ...args.state,
    view: EAccountsView.PastedCode,
    prompt: args.prompt,
    typed: '',
    failure: null,
    notice: null,
  }
}

export function askForApiKey(args: {
  state: AccountsState
  provider: EAuthProvider
}): AccountsState {
  return {
    ...args.state,
    view: EAccountsView.ApiKey,
    prompt: { provider: args.provider, url: '' },
    typed: '',
    failure: null,
    notice: null,
  }
}

export function typeInto(args: { state: AccountsState; text: string }): AccountsState {
  return { ...args.state, typed: `${args.state.typed}${args.text}`, failure: null }
}

export function backspace(state: AccountsState): AccountsState {
  return { ...state, typed: state.typed.slice(0, -1) }
}

export function backToList(state: AccountsState): AccountsState {
  return { ...state, view: EAccountsView.List, prompt: null, typed: '', busy: false }
}

export function working(state: AccountsState): AccountsState {
  return { ...state, busy: true, failure: null }
}

export function failed(args: { state: AccountsState; reason: string }): AccountsState {
  return { ...args.state, busy: false, failure: args.reason }
}

export function announced(args: { state: AccountsState; notice: string }): AccountsState {
  return { ...args.state, notice: args.notice, failure: null }
}

export const isPrompting = (state: AccountsState): boolean => state.view !== EAccountsView.List

export const kindLabel = (account: Account): string =>
  account.kind === EAuthKind.ApiKey ? 'api key' : 'subscription'

export const originLabel = (account: Account): string | null => {
  if (account.origin === EAccountOrigin.Imported) return 'imported'
  if (account.origin === EAccountOrigin.Environment) return 'from the environment'
  return null
}

export const statusLabel = (account: Account): string | null =>
  account.status === EAccountStatus.Active ? null : account.status

export function accountDetail(account: Account): string {
  const parts = [
    providerSpec(account.provider).label,
    kindLabel(account),
    originLabel(account),
    statusLabel(account),
  ]

  return parts.filter((part): part is string => part !== null).join(' · ')
}

export const maskedKey = (typed: string): string =>
  typed.length <= 4 ? '•'.repeat(typed.length) : `${'•'.repeat(typed.length - 4)}${typed.slice(-4)}`
