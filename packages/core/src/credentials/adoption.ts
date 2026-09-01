import type { OauthTokens } from './account'

export enum EAdoption {
  Adopt = 'adopt',
  Unchanged = 'unchanged',
  Foreign = 'foreign',
  Stale = 'stale',
  Unusable = 'unusable',
}

const expiryMillis = (tokens: OauthTokens): number => {
  const parsed = Date.parse(tokens.expiresAt)
  return Number.isNaN(parsed) ? 0 : parsed
}

export const isSamePair = (left: OauthTokens, right: OauthTokens): boolean =>
  left.accessToken === right.accessToken && left.refreshToken === right.refreshToken

export function adoptionOf(args: {
  observed: OauthTokens
  stored: OauthTokens
  others: readonly OauthTokens[]
}): EAdoption {
  const { observed, stored, others } = args

  if (observed.accessToken.length === 0 || observed.refreshToken.length === 0)
    return EAdoption.Unusable

  if (isSamePair(observed, stored)) return EAdoption.Unchanged

  const belongsToAnother = others.some(
    (other) =>
      other.accessToken === observed.accessToken || other.refreshToken === observed.refreshToken,
  )
  if (belongsToAnother) return EAdoption.Foreign

  if (expiryMillis(observed) < expiryMillis(stored)) return EAdoption.Stale

  return EAdoption.Adopt
}
