/**
 * Encrypt a secret with the same v1 AES-256-GCM format as SecretCipher (the runtime decrypt path),
 * for use by dev seeds that write encrypted values straight into Postgres. Pure function — no DB,
 * no Slack. (Was `cli/puppet-identity.ts`; the puppet `slack_identities` writer was removed with the
 * single-voice migration.)
 */
import { createCipheriv, randomBytes } from 'node:crypto';

export function encryptSecret(plain: string): string {
  const raw = process.env.SECRETS_ENCRYPTION_KEY;
  if (!raw) throw new Error('SECRETS_ENCRYPTION_KEY is not set');
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (key.length !== 32)
    throw new Error(
      `SECRETS_ENCRYPTION_KEY must decode to 32 bytes (got ${key.length})`,
    );
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}
