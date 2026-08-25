import { describe, expect, it } from 'bun:test'

import { parseClaudeCredentialBlob } from '../claude-credential-blob'
import { CredentialError, ECredentialFailure } from '../credential-error'

import {
  FAKE_ACCESS_TOKEN,
  FAKE_EXPIRES_AT_ISO,
  FAKE_REFRESH_TOKEN,
  fakeClaudeCredentialBlob,
} from './fixtures'

const captureCredentialError = (payload: string): CredentialError => {
  try {
    parseClaudeCredentialBlob(payload)
  } catch (thrown) {
    if (thrown instanceof CredentialError) return thrown
    throw thrown
  }
  throw new Error('expected parseClaudeCredentialBlob to throw')
}

describe('parseClaudeCredentialBlob', () => {
  it('reads the access token and expiry out of the blob Claude Code stores', () => {
    expect(parseClaudeCredentialBlob(fakeClaudeCredentialBlob())).toEqual({
      accessToken: FAKE_ACCESS_TOKEN,
      expiresAt: FAKE_EXPIRES_AT_ISO,
    })
  })

  it('carries nothing beyond the access token and expiry', () => {
    expect(Object.keys(parseClaudeCredentialBlob(fakeClaudeCredentialBlob())).sort()).toEqual([
      'accessToken',
      'expiresAt',
    ])
  })

  it('drops the refresh token, because this slice never refreshes', () => {
    const credential = parseClaudeCredentialBlob(fakeClaudeCredentialBlob())

    expect(JSON.stringify(credential)).not.toContain(FAKE_REFRESH_TOKEN)
  })

  it('fails as unreadable and names the missing field when the access token is absent', () => {
    const error = captureCredentialError(fakeClaudeCredentialBlob({ accessToken: undefined }))

    expect(error.failure).toBe(ECredentialFailure.Unreadable)
    expect(error.message).toContain('claudeAiOauth.accessToken')
  })

  it('fails as unreadable when the expiry is not epoch millis', () => {
    const error = captureCredentialError(fakeClaudeCredentialBlob({ expiresAt: 'tomorrow' }))

    expect(error.failure).toBe(ECredentialFailure.Unreadable)
    expect(error.message).toContain('claudeAiOauth.expiresAt')
  })

  it('fails as unreadable when the stored value is not JSON', () => {
    const error = captureCredentialError(`{"claudeAiOauth": {"accessToken": "${FAKE_ACCESS_TOKEN}"`)

    expect(error.failure).toBe(ECredentialFailure.Unreadable)
    expect(error.message).not.toContain(FAKE_ACCESS_TOKEN)
  })

  it('fails as unreadable when the blob is not an object', () => {
    expect(captureCredentialError('[]').failure).toBe(ECredentialFailure.Unreadable)
  })

  it('never puts the token in the message of any failure it raises', () => {
    const payloads = [
      fakeClaudeCredentialBlob({ expiresAt: 'tomorrow' }),
      fakeClaudeCredentialBlob({ expiresAt: null }),
      `not json at all ${FAKE_ACCESS_TOKEN}`,
      JSON.stringify({ claudeAiOauth: { accessToken: FAKE_ACCESS_TOKEN } }),
    ]

    for (const payload of payloads) {
      const error = captureCredentialError(payload)

      expect(error.message).not.toContain(FAKE_ACCESS_TOKEN)
      expect(error.stack ?? '').not.toContain(FAKE_ACCESS_TOKEN)
    }
  })
})
