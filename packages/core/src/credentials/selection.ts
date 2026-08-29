import { EAccountStatus, type Account, type AccountId, type EAuthProvider } from './account'

export enum EAccountChoice {
  Chosen = 'chosen',
  Refused = 'refused',
}

export enum ENoAccountReason {
  NoneAtAll = 'none-at-all',
  NoneForProvider = 'none-for-provider',
}

export type AccountChoice =
  | { type: EAccountChoice.Chosen; account: Account }
  | { type: EAccountChoice.Refused; reason: ENoAccountReason }

const HEALTH_ORDER: Record<EAccountStatus, number> = {
  [EAccountStatus.Active]: 0,
  [EAccountStatus.Limited]: 1,
  [EAccountStatus.Expired]: 2,
}

const freshestFirst = (left: Account, right: Account): number => {
  const health = HEALTH_ORDER[left.status] - HEALTH_ORDER[right.status]
  if (health !== 0) return health
  return right.updatedAt.localeCompare(left.updatedAt)
}

/**
 * An `expired` account is ranked last but never excluded: the status is only ever written by a
 * refresh that failed, and a refresh token the server has since accepted again would otherwise be
 * unreachable behind a status nothing clears.
 */
export function chooseAccount(args: {
  accounts: readonly Account[]
  provider: EAuthProvider
  preferred?: AccountId | undefined
}): AccountChoice {
  if (args.accounts.length === 0)
    return { type: EAccountChoice.Refused, reason: ENoAccountReason.NoneAtAll }

  const candidates = args.accounts.filter((account) => account.provider === args.provider)
  if (candidates.length === 0)
    return { type: EAccountChoice.Refused, reason: ENoAccountReason.NoneForProvider }

  const preferred = candidates.find((account) => account.id === args.preferred)
  if (preferred !== undefined) return { type: EAccountChoice.Chosen, account: preferred }

  const [best] = [...candidates].sort(freshestFirst)
  if (best === undefined)
    return { type: EAccountChoice.Refused, reason: ENoAccountReason.NoneForProvider }

  return { type: EAccountChoice.Chosen, account: best }
}
