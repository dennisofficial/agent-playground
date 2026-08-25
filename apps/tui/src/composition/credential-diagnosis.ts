import { CredentialError, ECredentialFailure } from '@dltech/atlas-harness'

export const CREDENTIAL_EXIT_CODE = 1

export type CredentialDiagnosis = { message: string; exitCode: number }

const HEADLINE = 'Atlas could not authenticate.'

const REAUTHENTICATE = 'Re-authenticate: run `claude` once, then start Atlas again.'

const adviceFor: Record<ECredentialFailure, string | null> = {
  [ECredentialFailure.StoreUnavailable]: null,
  [ECredentialFailure.NotFound]: REAUTHENTICATE,
  [ECredentialFailure.Unreadable]: REAUTHENTICATE,
  [ECredentialFailure.Expired]: REAUTHENTICATE,
}

export function diagnoseCredentialFailure(error: unknown): CredentialDiagnosis | null {
  if (!(error instanceof CredentialError)) return null

  const advice = adviceFor[error.failure]

  return {
    message: [HEADLINE, '', error.message, ...(advice === null ? [] : ['', advice])].join('\n'),
    exitCode: CREDENTIAL_EXIT_CODE,
  }
}
