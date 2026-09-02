import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EAccountOrigin,
  EAccountStatus,
  EAuthKind,
  EAuthProvider,
  toAccountId,
  type ClockPort,
} from '@dltech/atlas-core'

import { fileAccountStore } from '../account-store'
import { CredentialError, ECredentialFailure } from '../credential-error'
import { fileVaultBackend } from '../vault-backend'
import { VAULT_VERSION } from '../vault-file'

const FROM_ANOTHER_BUILD = 'quasar'
const AT = '2026-01-01T00:00:00.000Z'

const clock: ClockPort = { now: () => AT }

const sealed = (args: { id: string; provider: string; label: string }) => ({
  id: args.id,
  provider: args.provider,
  kind: EAuthKind.ApiKey,
  origin: EAccountOrigin.Login,
  label: args.label,
  status: EAccountStatus.Active,
  createdAt: AT,
  updatedAt: AT,
  secret: `sealed-${args.id}`,
})

const MINE = sealed({ id: 'acc_mine', provider: EAuthProvider.OpenRouter, label: 'openrouter' })
const THEIRS = sealed({ id: 'acc_theirs', provider: FROM_ANOTHER_BUILD, label: 'quasar' })

const MIXED = {
  version: VAULT_VERSION,
  accounts: [MINE, THEIRS],
  active: { [EAuthProvider.OpenRouter]: MINE.id, [FROM_ANOTHER_BUILD]: THEIRS.id },
}

let directory: string
let file: string

const write = (vault: unknown): void => writeFileSync(file, JSON.stringify(vault, null, 2))

const onDisk = (): unknown => JSON.parse(readFileSync(file, 'utf8'))

const failureOf = (read: () => unknown): CredentialError => {
  try {
    read()
  } catch (error: unknown) {
    if (error instanceof CredentialError) return error
    throw error
  }

  throw new Error('the vault was read without failing')
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'atlas-vault-backend-'))
  file = join(directory, 'auth.json')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('a vault holding a provider this build does not know', () => {
  it('reads the accounts it understands rather than refusing the whole file', () => {
    write(MIXED)

    const vault = fileVaultBackend(file).load()

    expect(vault.accounts.map((account) => account.id)).toEqual([toAccountId(MINE.id)])
    expect(vault.active[EAuthProvider.OpenRouter]).toBe(toAccountId(MINE.id))
  })

  it('writes back the account it could not read instead of dropping it', () => {
    write(MIXED)
    const backend = fileVaultBackend(file)
    const vault = backend.load()

    backend.save({ ...vault, accounts: [] })

    expect(onDisk()).toEqual({ version: VAULT_VERSION, accounts: [THEIRS], active: MIXED.active })
  })

  it('keeps both when an account is added beside one it could not read', async () => {
    write(MIXED)
    const store = fileAccountStore({ file, keyFile: join(directory, 'key'), clock })

    await store.add({
      provider: EAuthProvider.Anthropic,
      label: 'work',
      secret: { kind: EAuthKind.ApiKey, apiKey: 'sk-not-a-real-key' },
      origin: EAccountOrigin.Login,
    })

    const labels = (await store.list()).map((account) => account.label)
    expect(labels).toEqual([MINE.label, 'work'])
    expect(JSON.stringify(onDisk())).toContain(THEIRS.secret)
  })
})

describe('a vault this build cannot use at all', () => {
  it('refuses a file that is not JSON', () => {
    writeFileSync(file, '{ not json')

    expect(failureOf(() => fileVaultBackend(file).load()).failure).toBe(
      ECredentialFailure.Unreadable,
    )
  })

  it('refuses a known account that is missing what every account carries', () => {
    write({ ...MIXED, accounts: [{ ...MINE, label: undefined }] })

    expect(failureOf(() => fileVaultBackend(file).load()).failure).toBe(
      ECredentialFailure.Unreadable,
    )
  })

  it('names the version of a newer vault rather than telling the operator to move it aside', () => {
    write({ ...MIXED, version: VAULT_VERSION + 1 })

    const failure = failureOf(() => fileVaultBackend(file).load())

    expect(failure.failure).toBe(ECredentialFailure.Unsupported)
    expect(failure.message).toContain(`version ${VAULT_VERSION + 1}`)
    expect(failure.message).not.toContain('Move it aside')
  })
})
