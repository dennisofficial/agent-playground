import { EAuthKind, type AccountSecret } from './account'

export enum ERefresh {
  Fresh = 'fresh',
  Due = 'due',
  Unrefreshable = 'unrefreshable',
}

export const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000

const millisOf = (iso: string): number | null => {
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? null : parsed
}

export function refreshDecision(args: {
  secret: AccountSecret
  now: string
  skewMs?: number
  revoked?: boolean
}): ERefresh {
  if (args.secret.kind === EAuthKind.ApiKey) return ERefresh.Fresh

  const canRefresh = args.secret.tokens.refreshToken.length > 0
  if (args.revoked === true) return canRefresh ? ERefresh.Due : ERefresh.Unrefreshable

  const nowMillis = millisOf(args.now)
  const expiresAtMillis = millisOf(args.secret.tokens.expiresAt)

  if (nowMillis === null || expiresAtMillis === null) {
    return canRefresh ? ERefresh.Due : ERefresh.Unrefreshable
  }

  const skewMs = args.skewMs ?? DEFAULT_REFRESH_SKEW_MS
  if (expiresAtMillis - nowMillis > skewMs) return ERefresh.Fresh

  return canRefresh ? ERefresh.Due : ERefresh.Unrefreshable
}

export function isExpired(args: { secret: AccountSecret; now: string }): boolean {
  if (args.secret.kind === EAuthKind.ApiKey) return false

  const nowMillis = millisOf(args.now)
  const expiresAtMillis = millisOf(args.secret.tokens.expiresAt)
  if (nowMillis === null || expiresAtMillis === null) return true

  return expiresAtMillis <= nowMillis
}
