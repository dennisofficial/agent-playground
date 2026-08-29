import { describe, expect, it } from 'bun:test'

import {
  EAccountOrigin,
  EAccountStatus,
  EAuthKind,
  EAuthProvider,
  toAccountId,
  type Account,
} from '../account'
import { chooseAccount, EAccountChoice, ENoAccountReason } from '../selection'

const account = (args: {
  id: string
  provider?: EAuthProvider
  status?: EAccountStatus
  updatedAt?: string
}): Account => ({
  id: toAccountId(args.id),
  provider: args.provider ?? EAuthProvider.Anthropic,
  kind: EAuthKind.Oauth,
  origin: EAccountOrigin.Login,
  label: args.id,
  status: args.status ?? EAccountStatus.Active,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: args.updatedAt ?? '2026-01-01T00:00:00.000Z',
})

const chosenId = (accounts: readonly Account[], preferred?: string): string | undefined => {
  const choice = chooseAccount({
    accounts,
    provider: EAuthProvider.Anthropic,
    ...(preferred === undefined ? {} : { preferred: toAccountId(preferred) }),
  })
  return choice.type === EAccountChoice.Chosen ? choice.account.id : undefined
}

describe('chooseAccount', () => {
  it('answers with the account the operator picked', () => {
    const accounts = [account({ id: 'work' }), account({ id: 'personal' })]

    expect(chosenId(accounts, 'personal')).toBe('personal')
  })

  it('falls back to the healthiest account when the preferred one is gone', () => {
    const accounts = [
      account({ id: 'limited', status: EAccountStatus.Limited }),
      account({ id: 'active' }),
    ]

    expect(chosenId(accounts, 'deleted')).toBe('active')
  })

  it('breaks a tie on which account was touched most recently', () => {
    const accounts = [
      account({ id: 'older', updatedAt: '2026-01-01T00:00:00.000Z' }),
      account({ id: 'newer', updatedAt: '2026-02-01T00:00:00.000Z' }),
    ]

    expect(chosenId(accounts)).toBe('newer')
  })

  it('still hands back an expired account, because a refresh is what clears that status', () => {
    const accounts = [account({ id: 'dead', status: EAccountStatus.Expired })]

    expect(chosenId(accounts)).toBe('dead')
  })

  it('honours a preferred account even when a healthier one exists', () => {
    const accounts = [
      account({ id: 'dead', status: EAccountStatus.Expired }),
      account({ id: 'alive' }),
    ]

    expect(chosenId(accounts, 'dead')).toBe('dead')
  })

  it('separates having no accounts from having none for the provider asked for', () => {
    const other = [account({ id: 'openai-one', provider: EAuthProvider.OpenAI })]

    expect(chooseAccount({ accounts: [], provider: EAuthProvider.Anthropic })).toEqual({
      type: EAccountChoice.Refused,
      reason: ENoAccountReason.NoneAtAll,
    })
    expect(chooseAccount({ accounts: other, provider: EAuthProvider.Anthropic })).toEqual({
      type: EAccountChoice.Refused,
      reason: ENoAccountReason.NoneForProvider,
    })
  })
})
