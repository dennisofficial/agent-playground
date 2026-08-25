import { describe, expect, it } from 'bun:test'

import { CredentialError, ECredentialFailure } from '../credential-error'
import { assertCredentialIsUnexpired } from '../expiry'

import { FAKE_ACCESS_TOKEN } from './fixtures'

const credentialExpiringAt = (expiresAt: string) => ({ accessToken: FAKE_ACCESS_TOKEN, expiresAt })

const captureCredentialError = (args: { expiresAt: string; now: string }): CredentialError => {
  try {
    assertCredentialIsUnexpired({ credential: credentialExpiringAt(args.expiresAt), now: args.now })
  } catch (thrown) {
    if (thrown instanceof CredentialError) return thrown
    throw thrown
  }
  throw new Error('expected assertCredentialIsUnexpired to throw')
}

describe('assertCredentialIsUnexpired', () => {
  it('accepts an expiry in the future', () => {
    expect(() =>
      assertCredentialIsUnexpired({
        credential: credentialExpiringAt('2026-08-24T12:00:00.000Z'),
        now: '2026-08-24T11:59:59.000Z',
      }),
    ).not.toThrow()
  })

  it('tells the operator to run claude once when the expiry is in the past', () => {
    const error = captureCredentialError({
      expiresAt: '2026-08-24T11:00:00.000Z',
      now: '2026-08-24T12:00:00.000Z',
    })

    expect(error.failure).toBe(ECredentialFailure.Expired)
    expect(error.message).toContain('claude')
    expect(error.message).toContain('2026-08-24T11:00:00.000Z')
  })

  it('treats an expiry exactly at now as expired', () => {
    expect(
      captureCredentialError({
        expiresAt: '2026-08-24T12:00:00.000Z',
        now: '2026-08-24T12:00:00.000Z',
      }).failure,
    ).toBe(ECredentialFailure.Expired)
  })

  it('fails as unreadable when the expiry is not a timestamp', () => {
    expect(
      captureCredentialError({ expiresAt: 'whenever', now: '2026-08-24T12:00:00.000Z' }).failure,
    ).toBe(ECredentialFailure.Unreadable)
  })

  it('keeps the token out of every failure it raises', () => {
    const cases = [
      { expiresAt: '2026-08-24T11:00:00.000Z', now: '2026-08-24T12:00:00.000Z' },
      { expiresAt: 'whenever', now: '2026-08-24T12:00:00.000Z' },
      { expiresAt: '2026-08-24T11:00:00.000Z', now: 'never' },
    ]

    for (const args of cases) {
      const error = captureCredentialError(args)

      expect(error.message).not.toContain(FAKE_ACCESS_TOKEN)
    }
  })
})
