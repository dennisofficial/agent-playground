import { CredentialError, ECredentialFailure } from '@dltech/atlas-harness'

export const CREDENTIAL_EXIT_CODE = 1

export type CredentialDiagnosis = { message: string; exitCode: number }

const HEADLINE = 'Atlas could not authenticate.'

const SIGN_IN = 'Sign in from the accounts overlay: press ctrl+a, or run /auth.'

const adviceFor: Record<ECredentialFailure, string | null> = {
  [ECredentialFailure.StoreUnavailable]: null,
  [ECredentialFailure.NotFound]: SIGN_IN,
  [ECredentialFailure.Unreadable]: SIGN_IN,
  [ECredentialFailure.Unsupported]: 'Update Atlas to a build that can read it.',
  [ECredentialFailure.Expired]: SIGN_IN,
  [ECredentialFailure.RefreshFailed]: 'Check the network, then try the turn again.',
}

export function diagnoseCredentialFailure(error: unknown): CredentialDiagnosis | null {
  if (!(error instanceof CredentialError)) return null

  const advice = adviceFor[error.failure]

  return {
    message: [HEADLINE, '', error.message, ...(advice === null ? [] : ['', advice])].join('\n'),
    exitCode: CREDENTIAL_EXIT_CODE,
  }
}
