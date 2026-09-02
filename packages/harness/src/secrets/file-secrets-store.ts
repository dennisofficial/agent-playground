import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { SecretsPort } from '@dltech/atlas-core'

import { CredentialError, ECredentialFailure } from '../credentials/credential-error'
import type { SecretCipher } from '../credentials/secret-cipher'
import { emptySecrets, secretsFileSchema, type SecretsFile } from './secrets-file'

const OWNER_ONLY = 0o600

export class FileSecretsStore implements SecretsPort {
  constructor(private readonly args: { file: string; cipher: SecretCipher }) {}

  origin(): string {
    return this.args.file
  }

  read(name: string): string | undefined {
    const sealed = this.load().secrets[name]
    return sealed === undefined ? undefined : this.args.cipher.decrypt(sealed)
  }

  write(written: { name: string; value: string }): void {
    const held = this.load()
    const sealed = this.args.cipher.encrypt(written.value)
    this.save({ ...held, secrets: { ...held.secrets, [written.name]: sealed } })
  }

  remove(name: string): void {
    const held = this.load()
    const secrets = { ...held.secrets }
    delete secrets[name]
    this.save({ ...held, secrets })
  }

  private load(): SecretsFile {
    let text: string
    try {
      text = readFileSync(this.args.file, 'utf8')
    } catch {
      return emptySecrets()
    }

    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw this.unreadable('the file is not valid JSON')
    }

    const parsed = secretsFileSchema.safeParse(json)
    if (!parsed.success) throw this.unreadable('the file does not hold secrets')

    return parsed.data
  }

  /**
   * Written beside the target and renamed in, because rename is the only filesystem operation that
   * is atomic across the platforms Atlas runs on: a crash mid-write must never leave a half file.
   */
  private save(held: SecretsFile): void {
    mkdirSync(dirname(this.args.file), { recursive: true })

    const staging = join(dirname(this.args.file), `.${randomUUID()}.tmp`)
    writeFileSync(staging, `${JSON.stringify(held, null, 2)}\n`, { mode: OWNER_ONLY })
    renameSync(staging, this.args.file)
  }

  private unreadable(detail: string): CredentialError {
    return new CredentialError({
      failure: ECredentialFailure.Unreadable,
      message: `The secrets file at ${this.args.file} could not be read: ${detail}. Move it aside and set the keys again from settings.`,
    })
  }
}
