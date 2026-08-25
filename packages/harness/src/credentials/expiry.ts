import type { Credential } from '@dltech/atlas-core'

import { CredentialError, ECredentialFailure } from './credential-error'

export const assertCredentialIsUnexpired = (args: {
  credential: Credential
  now: string
}): void => {
  const expiresAtMillis = Date.parse(args.credential.expiresAt)
  const nowMillis = Date.parse(args.now)

  if (Number.isNaN(expiresAtMillis) || Number.isNaN(nowMillis)) {
    throw new CredentialError({
      failure: ECredentialFailure.Unreadable,
      message:
        'The Claude Code credential carries an expiry that is not a timestamp. Run `claude` once to sign in again.',
    })
  }

  if (expiresAtMillis > nowMillis) return

  throw new CredentialError({
    failure: ECredentialFailure.Expired,
    message: `The Claude Code credential expired at ${args.credential.expiresAt}. Run \`claude\` once to refresh it, then try again.`,
  })
}
