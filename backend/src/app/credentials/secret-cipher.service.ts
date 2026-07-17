import { EnvService } from '@core/config/env/env.service';
import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // 96-bit nonce, the GCM standard
const TAG_LEN = 16;

/**
 * AES-256-GCM cipher for secrets-at-rest. The key comes from `SECRETS_ENCRYPTION_KEY` (64 hex chars
 * or 32-byte base64) and is loaded once at construction. Ciphertext format is `iv.tag.ct` (base64
 * parts). Internal to the credentials vault — nothing else should encrypt org secrets.
 */
@Injectable()
export class SecretCipherService {
  private readonly key: Buffer;

  constructor(env: EnvService) {
    const raw = env.get('SECRETS_ENCRYPTION_KEY');
    const key = /^[0-9a-fA-F]{64}$/.test(raw)
      ? Buffer.from(raw, 'hex')
      : Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new Error(
        `SECRETS_ENCRYPTION_KEY must decode to 32 bytes (got ${key.length}) — use 64 hex chars or 32-byte base64.`,
      );
    }
    this.key = key;
  }

  encrypt(plain: string): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
  }

  decrypt(blob: string): string {
    const parts = blob.split('.');
    if (parts.length !== 3)
      throw new Error('Malformed encrypted secret blob (expected iv.tag.ct).');
    const [ivB64, tagB64, ctB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
    if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
      throw new Error('Malformed encrypted secret blob (bad iv/tag length).');
    }
    const decipher = createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }
}
