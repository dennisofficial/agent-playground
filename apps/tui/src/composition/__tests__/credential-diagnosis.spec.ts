import { CredentialError, ECredentialFailure } from '@dltech/atlas-harness'
import { describe, expect, it } from 'bun:test'

import { CREDENTIAL_EXIT_CODE, diagnoseCredentialFailure } from '../credential-diagnosis'

const failing = (failure: ECredentialFailure, message: string): CredentialError =>
  new CredentialError({ failure, message })

describe('what the operator is told when the credential is gone', () => {
  it('exits non-zero on a credential that is not there', () => {
    const diagnosis = diagnoseCredentialFailure(
      failing(ECredentialFailure.NotFound, 'No credential could be read.'),
    )

    expect(diagnosis?.exitCode).toBe(CREDENTIAL_EXIT_CODE)
    expect(diagnosis?.exitCode).toBeGreaterThan(0)
  })

  it('says to re-authenticate on a credential that expired', () => {
    const diagnosis = diagnoseCredentialFailure(
      failing(ECredentialFailure.Expired, 'The credential expired at 2026-01-01T00:00:00.000Z.'),
    )

    expect(diagnosis?.message).toContain('Re-authenticate')
    expect(diagnosis?.message).toContain('claude')
    expect(diagnosis?.message).toContain('expired at 2026-01-01T00:00:00.000Z')
  })

  it('says to re-authenticate on a credential it could not parse', () => {
    const diagnosis = diagnoseCredentialFailure(
      failing(ECredentialFailure.Unreadable, 'The credential is not a timestamp.'),
    )

    expect(diagnosis?.message).toContain('Re-authenticate')
  })

  it('does not tell the operator to re-authenticate when the store itself is missing', () => {
    const diagnosis = diagnoseCredentialFailure(
      failing(ECredentialFailure.StoreUnavailable, 'The Keychain backend needs macOS.'),
    )

    expect(diagnosis?.message).toContain('needs macOS')
    expect(diagnosis?.message).not.toContain('Re-authenticate')
  })

  it('leaves anything that is not a credential failure to the caller', () => {
    expect(diagnoseCredentialFailure(new Error('the database is locked'))).toBeNull()
    expect(diagnoseCredentialFailure('nope')).toBeNull()
  })
})
