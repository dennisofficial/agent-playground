import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { accountSecretSchema, type AccountSecret } from '@dltech/atlas-core'

import { CredentialError, ECredentialFailure } from './credential-error'
import type { SecretCipher } from './secret-cipher'
import { emptyVault, vaultFileSchema, type VaultFile } from './vault-file'

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

export const parseVault = (args: { text: string; where: string }): VaultFile => {
  let json: unknown
  try {
    json = JSON.parse(args.text)
  } catch {
    throw unreadable(args.where, 'the file is not valid JSON')
  }

  const parsed = vaultFileSchema.safeParse(json)
  if (!parsed.success) throw unreadable(args.where, 'the file does not hold an account vault')

  return parsed.data
}

export const fileVaultBackend = (file: string): VaultBackend => ({
  name: file,

  load: () => {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return emptyVault()
    }

    return parseVault({ text, where: file })
  },

  save: (vault) => {
    mkdirSync(dirname(file), { recursive: true })

    const temporary = join(dirname(file), `.${randomUUID()}.tmp`)
    writeFileSync(temporary, `${JSON.stringify(vault, null, 2)}\n`, { mode: OWNER_ONLY })
    renameSync(temporary, file)
  },
})

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
