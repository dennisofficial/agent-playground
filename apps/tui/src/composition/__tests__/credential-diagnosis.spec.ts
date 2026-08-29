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

  it('points at the accounts overlay when the credential expired', () => {
    const diagnosis = diagnoseCredentialFailure(
      failing(ECredentialFailure.Expired, 'The credential expired at 2026-01-01T00:00:00.000Z.'),
    )

    expect(diagnosis?.message).toContain('/auth')
    expect(diagnosis?.message).toContain('expired at 2026-01-01T00:00:00.000Z')
  })

  it('points at the accounts overlay when the credential cannot be parsed', () => {
    const diagnosis = diagnoseCredentialFailure(
      failing(ECredentialFailure.Unreadable, 'The credential is not a timestamp.'),
    )

    expect(diagnosis?.message).toContain('/auth')
  })

  it('says nothing about signing in when the store itself is missing', () => {
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
