import { describe, expect, it } from 'bun:test'

import type { ClockPort } from '@dltech/atlas-core'

import { CredentialError, ECredentialFailure } from '../credential-error'
import {
  CLAUDE_CODE_CREDENTIAL_SERVICE,
  KeychainCredentialPort,
} from '../keychain-credential-port'
import type { KeychainReader } from '../keychain-reader'

import {
  FAKE_ACCESS_TOKEN,
  FAKE_EXPIRES_AT_ISO,
  fakeClaudeCredentialBlob,
} from './fixtures'

const fixedClock = (now: string): ClockPort => ({ now: () => now })

const beforeFakeExpiry = fixedClock(new Date(Date.parse(FAKE_EXPIRES_AT_ISO) - 60_000).toISOString())
const afterFakeExpiry = fixedClock(new Date(Date.parse(FAKE_EXPIRES_AT_ISO) + 60_000).toISOString())

class RecordingKeychainReader implements KeychainReader {
  readonly requestedServices: string[] = []

  constructor(private readonly payload: string) {}

  async readGenericPassword(args: { service: string }): Promise<string> {
    this.requestedServices.push(args.service)
    return this.payload
  }
}

class FailingKeychainReader implements KeychainReader {
  constructor(private readonly failure: CredentialError) {}

  async readGenericPassword(): Promise<string> {
    throw this.failure
  }
}

const captureCredentialError = async (port: KeychainCredentialPort): Promise<CredentialError> => {
  try {
    await port.read()
  } catch (thrown) {
    if (thrown instanceof CredentialError) return thrown
    throw thrown
  }
  throw new Error('expected read to throw')
}

describe('KeychainCredentialPort', () => {
  it('returns the credential the keychain holds', async () => {
    const port = new KeychainCredentialPort({
      reader: new RecordingKeychainReader(fakeClaudeCredentialBlob()),
      clock: beforeFakeExpiry,
    })

    expect(await port.read()).toEqual({
      accessToken: FAKE_ACCESS_TOKEN,
      expiresAt: FAKE_EXPIRES_AT_ISO,
    })
  })

  it('asks for the service name Claude Code writes under', async () => {
    const reader = new RecordingKeychainReader(fakeClaudeCredentialBlob())

    await new KeychainCredentialPort({ reader, clock: beforeFakeExpiry }).read()

    expect(reader.requestedServices).toEqual([CLAUDE_CODE_CREDENTIAL_SERVICE])
    expect(CLAUDE_CODE_CREDENTIAL_SERVICE).toBe('Claude Code-credentials')
  })

  it('re-reads the store on every read rather than caching', async () => {
    const reader = new RecordingKeychainReader(fakeClaudeCredentialBlob())
    const port = new KeychainCredentialPort({ reader, clock: beforeFakeExpiry })

    await port.read()
    await port.read()
    await port.read()

    expect(reader.requestedServices).toHaveLength(3)
  })

  it('surfaces an expiry in the past as a failure telling the operator to run claude', async () => {
    const port = new KeychainCredentialPort({
      reader: new RecordingKeychainReader(fakeClaudeCredentialBlob()),
      clock: afterFakeExpiry,
    })

    const error = await captureCredentialError(port)

    expect(error.failure).toBe(ECredentialFailure.Expired)
    expect(error.message).toContain('claude')
    expect(error.message).not.toContain(FAKE_ACCESS_TOKEN)
  })

  it('attempts no refresh when the credential has expired', async () => {
    const reader = new RecordingKeychainReader(fakeClaudeCredentialBlob())

    await captureCredentialError(new KeychainCredentialPort({ reader, clock: afterFakeExpiry }))

    expect(reader.requestedServices).toHaveLength(1)
  })

  it('passes a store failure through untouched', async () => {
    const failure = new CredentialError({
      failure: ECredentialFailure.NotFound,
      message: 'no credential in the keychain',
    })

    const error = await captureCredentialError(
      new KeychainCredentialPort({
        reader: new FailingKeychainReader(failure),
        clock: beforeFakeExpiry,
      }),
    )

    expect(error).toBe(failure)
  })

  it('reports a malformed stored value without quoting it', async () => {
    const port = new KeychainCredentialPort({
      reader: new RecordingKeychainReader(`{"claudeAiOauth": "${FAKE_ACCESS_TOKEN}"`),
      clock: beforeFakeExpiry,
    })

    const error = await captureCredentialError(port)

    expect(error.failure).toBe(ECredentialFailure.Unreadable)
    expect(error.message).not.toContain(FAKE_ACCESS_TOKEN)
  })
})
