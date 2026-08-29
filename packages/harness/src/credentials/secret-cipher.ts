import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { CredentialError, ECredentialFailure } from './credential-error'

const ALGORITHM = 'aes-256-gcm'
const NONCE_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const OWNER_ONLY = 0o600

export class SecretCipher {
  private key: Buffer | undefined

  constructor(private readonly keyFile: string) {}

  encrypt(plaintext: string): string {
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv(ALGORITHM, this.loadKey(), nonce)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])

    return [nonce, cipher.getAuthTag(), ciphertext]
      .map((part) => part.toString('base64'))
      .join('.')
  }

  decrypt(blob: string): string {
    const [nonceText, tagText, ciphertextText, ...rest] = blob.split('.')

    if (nonceText === undefined || tagText === undefined || ciphertextText === undefined)
      throw this.unreadable()
    if (rest.length > 0) throw this.unreadable()

    const nonce = Buffer.from(nonceText, 'base64')
    const tag = Buffer.from(tagText, 'base64')
    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) throw this.unreadable()

    try {
      const decipher = createDecipheriv(ALGORITHM, this.loadKey(), nonce)
      decipher.setAuthTag(tag)
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextText, 'base64')),
        decipher.final(),
      ]).toString('utf8')
    } catch {
      throw this.unreadable()
    }
  }

  private unreadable(): CredentialError {
    return new CredentialError({
      failure: ECredentialFailure.Unreadable,
      message: `A stored credential could not be decrypted with ${this.keyFile}. Sign in again with /auth.`,
    })
  }

  private loadKey(): Buffer {
    const cached = this.key
    if (cached !== undefined) return cached

    mkdirSync(dirname(this.keyFile), { recursive: true })

    const key = Buffer.from(this.readOrCreateKeyText(), 'hex')
    if (key.length !== KEY_BYTES) {
      throw new CredentialError({
        failure: ECredentialFailure.Unreadable,
        message: `${this.keyFile} must hold ${KEY_BYTES * 2} hex characters; it holds ${key.length} bytes.`,
      })
    }

    chmodSync(this.keyFile, OWNER_ONLY)
    this.key = key
    return key
  }

  private readOrCreateKeyText(): string {
    try {
      return readFileSync(this.keyFile, 'utf8').trim()
    } catch {
      const created = randomBytes(KEY_BYTES).toString('hex')
      writeFileSync(this.keyFile, `${created}\n`, { mode: OWNER_ONLY })
      return created
    }
  }
}
