import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { accountSecretSchema, type AccountSecret } from '@dltech/atlas-core'

import { CredentialError, ECredentialFailure } from './credential-error'
import type { SecretCipher } from './secret-cipher'
import {
  emptyRemainder,
  emptyVault,
  readVaultEnvelope,
  vaultEnvelopeSchema,
  VAULT_VERSION,
  versionedFileSchema,
  withRemainder,
  type VaultFile,
  type VaultReading,
  type VaultRemainder,
} from './vault-file'

const OWNER_ONLY = 0o600

export interface VaultBackend {
  readonly name: string
  load(): VaultFile
  save(vault: VaultFile): void
}

export interface SecretBox {
  seal(secret: AccountSecret): string
  open(sealed: string): AccountSecret
}

const unreadable = (where: string, detail: string): CredentialError =>
  new CredentialError({
    failure: ECredentialFailure.Unreadable,
    message: `The account vault at ${where} could not be read: ${detail}. Move it aside and sign in again with /auth.`,
  })

const writtenByANewerAtlas = (where: string, version: number): CredentialError =>
  new CredentialError({
    failure: ECredentialFailure.Unsupported,
    message: `The account vault at ${where} is version ${version}, and this build of Atlas understands version ${VAULT_VERSION}. The accounts in it are intact — update Atlas rather than moving the vault aside.`,
  })

export const parseVault = (args: { text: string; where: string }): VaultReading => {
  let json: unknown
  try {
    json = JSON.parse(args.text)
  } catch {
    throw unreadable(args.where, 'the file is not valid JSON')
  }

  const versioned = versionedFileSchema.safeParse(json)
  if (versioned.success && versioned.data.version > VAULT_VERSION)
    throw writtenByANewerAtlas(args.where, versioned.data.version)

  const envelope = vaultEnvelopeSchema.safeParse(json)
  if (!envelope.success) throw unreadable(args.where, 'the file does not hold an account vault')

  const reading = readVaultEnvelope(envelope.data)
  if (reading === undefined)
    throw unreadable(args.where, 'an account in it is not in the shape Atlas writes')

  return reading
}

export const fileVaultBackend = (file: string): VaultBackend => {
  let remainder: VaultRemainder = emptyRemainder()

  return {
    name: file,

    load: () => {
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        remainder = emptyRemainder()
        return emptyVault()
      }

      const reading = parseVault({ text, where: file })
      remainder = reading.remainder

      return reading.vault
    },

    save: (vault) => {
      mkdirSync(dirname(file), { recursive: true })

      const written = JSON.stringify(withRemainder({ vault, remainder }), null, 2)
      const temporary = join(dirname(file), `.${randomUUID()}.tmp`)
      writeFileSync(temporary, `${written}\n`, { mode: OWNER_ONLY })
      renameSync(temporary, file)
    },
  }
}

export const memoryVaultBackend = (): VaultBackend => {
  let held: VaultFile = emptyVault()

  return {
    name: 'memory',
    load: () => held,
    save: (vault) => {
      held = vault
    },
  }
}

export const cipherSecretBox = (args: { cipher: SecretCipher; where: string }): SecretBox => ({
  seal: (secret) => args.cipher.encrypt(JSON.stringify(secret)),
  open: (sealed) => {
    const parsed = accountSecretSchema.safeParse(JSON.parse(args.cipher.decrypt(sealed)))
    if (!parsed.success) throw unreadable(args.where, 'a stored secret is malformed')

    return parsed.data
  },
})

export const plainSecretBox = (): SecretBox => ({
  seal: (secret) => JSON.stringify(secret),
  open: (sealed) => accountSecretSchema.parse(JSON.parse(sealed)),
})
