import { EnvService } from '@core/config/env/env.service';
import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM at-rest encryption for stored secrets (GitHub tokens). Key from
 * SECRETS_ENCRYPTION_KEY (base64 or hex, must decode to exactly 32 bytes), resolved lazily per
 * call so a missing key never fails boot — writes refuse with an actionable error instead.
 * Ciphertext format: `v1:<iv b64>:<tag b64>:<ct b64>`.
 */
@Injectable()
export class SecretCipher {
  constructor(private readonly env: EnvService) {}

  isConfigured(): boolean {
    return !!this.env.get('SECRETS_ENCRYPTION_KEY');
  }

  private key(): Buffer {
    const raw = this.env.get('SECRETS_ENCRYPTION_KEY');
    if (!raw) {
      throw new Error(
        'SECRETS_ENCRYPTION_KEY is not set — generate one with `openssl rand -base64 32` and add it to the env before storing tokens.',
      );
    }
    const buf = /^[0-9a-fA-F]{64}$/.test(raw)
      ? Buffer.from(raw, 'hex')
      : Buffer.from(raw, 'base64');
    if (buf.length !== 32) {
      throw new Error(
        `SECRETS_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${buf.length}) — use \`openssl rand -base64 32\`.`,
      );
    }
    return buf;
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
  }

  decrypt(ciphertext: string): string {
    const [version, iv, tag, ct] = ciphertext.split(':');
    if (version !== 'v1' || !iv || !tag || !ct) {
      throw new Error(
        'Unrecognized ciphertext format (expected v1:<iv>:<tag>:<ct>).',
      );
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key(),
      Buffer.from(iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ct, 'base64')),
      decipher.final(), // throws on tamper (auth tag mismatch)
    ]).toString('utf8');
  }
}
